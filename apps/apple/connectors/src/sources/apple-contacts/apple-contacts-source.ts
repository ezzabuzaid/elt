import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtempDisposable, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setInterval } from 'node:timers/promises';

import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Source, diffSnapshot, validateRecords } from '@workspace/elt';
import {
  type ImportScope,
  selected,
} from '@workspace/source-apple-macos/import-scope';
import { localAppleStoreCoverage } from '@workspace/source-apple-macos/local-apple-store-coverage';

import {
  AddressBook,
  type AddressBookStore,
  AddressBookVersion,
  type StoredData,
  addressBookDirectory,
} from '../../platform/macos/address-book.ts';
import {
  type StreamName,
  catalog,
  definitions,
  recordFrom,
  requiredSchema,
} from './contacts-streams.ts';

const isStreamName = (name: string): name is StreamName =>
  Object.hasOwn(definitions, name);

const imageKey = (contactId: unknown, kind: unknown) =>
  JSON.stringify([contactId, kind]);

async function sha256(data: StoredData): Promise<string> {
  const hash = createHash('sha256');
  if (data.storage === 'inline') hash.update(data.bytes);
  else
    for await (const chunk of createReadStream(data.path)) hash.update(chunk);
  return hash.digest('hex');
}

// How often a watch checks the stores for commits.
const pollIntervalMs = 1000;

// Reads Contacts' own Core Data stores, one per account, so Contacts.app
// need not run and no Contacts.framework entitlement is needed for notes.
export class AppleContactsSource extends Source<AddressBook> {
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly containers = catalog.get('containers');
  readonly groups = catalog.get('groups');
  readonly groupMembers = catalog.get('groupMembers');
  readonly groupSubgroups = catalog.get('groupSubgroups');
  readonly contacts = catalog.get('contacts');
  readonly notes = catalog.get('notes');
  readonly alternateBirthdays = catalog.get('alternateBirthdays');
  readonly phoneNumbers = catalog.get('phoneNumbers');
  readonly emailAddresses = catalog.get('emailAddresses');
  readonly postalAddresses = catalog.get('postalAddresses');
  readonly urlAddresses = catalog.get('urlAddresses');
  readonly socialProfiles = catalog.get('socialProfiles');
  readonly messagingAddresses = catalog.get('messagingAddresses');
  readonly relatedNames = catalog.get('relatedNames');
  readonly contactDates = catalog.get('contactDates');
  readonly calendarUris = catalog.get('calendarUris');
  readonly addressingGrammars = catalog.get('addressingGrammars');
  readonly likenesses = catalog.get('likenesses');
  readonly alertTones = catalog.get('alertTones');
  readonly customPropertyValues = catalog.get('customPropertyValues');
  readonly remoteLocations = catalog.get('remoteLocations');
  readonly unknownProperties = catalog.get('unknownProperties');
  readonly distributionListConfigs = catalog.get('distributionListConfigs');
  readonly images = catalog.get('images');

  readonly directory: string;
  readonly scope: ImportScope;

  constructor(directory = addressBookDirectory, scope: ImportScope = {}) {
    super();
    this.directory = directory;
    this.scope = scope;
    this.identity = `apple-contacts:${directory}`;
    Object.freeze(this);
  }

  protected override open(): Promise<AddressBook> {
    return AddressBook.open(this.directory, requiredSchema);
  }

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using version = new AddressBookVersion(this.directory);
    let seen = version.current;
    yield streams;
    try {
      for await (const _ of setInterval(pollIntervalMs, undefined, {
        signal,
      })) {
        const current = version.current;
        if (current === seen) continue;
        seen = current;
        yield streams;
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) throw error;
    }
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    book: AddressBook,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const { name } = stream;
    if (!isStreamName(name))
      throw new TypeError(`Contacts has no stream ${name}`);
    const files = new Map<string, StoredData>();
    const rows = [];
    for (const store of book.stores) {
      const accepts = contactSelection(store, this.scope);
      rows.push(
        ...(name === 'images'
          ? await this.#images(store, files, accepts)
          : store
              .all(definitions[name].sql)
              .filter((row) => accepts(name, row))
              .map((row) => {
                const record = recordFrom(name, row);
                if (name === 'containers') record.source = store.source;
                return record;
              })),
      );
    }
    const records = validateRecords(stream, rows, 'Contacts');
    const messages =
      configuration.syncMode === 'incremental'
        ? diffSnapshot(stream, records, state)
        : records.map((data) => ({ stream: stream.name, data }));
    if (configuration.fileReads.length === 0 || name !== 'images') {
      yield* messages;
      return;
    }
    await using staging = await mkdtempDisposable(
      join(tmpdir(), 'elt-contacts-'),
    );
    let staged = 0;
    for await (const message of messages) {
      if ('type' in message) {
        yield message;
        continue;
      }
      const data = files.get(
        imageKey(message.data.contactId, message.data.kind),
      );
      if (data === undefined)
        throw new TypeError('Contacts image record lost its stored data');
      if (data.storage === 'external') {
        // The original file: readers only read it.
        yield { ...message, file: data.path };
        continue;
      }
      const path = join(staging.path, String(staged++));
      await writeFile(path, data.bytes);
      yield { ...message, file: path };
      await rm(path);
    }
  }

  async #images(
    store: AddressBookStore,
    files: Map<string, StoredData>,
    accepts: (name: StreamName, row: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>[]> {
    const records: Record<string, unknown>[] = [];
    for (const row of store
      .all(definitions.images.sql)
      .filter((row) => accepts('images', row)))
      for (const kind of ['image', 'thumbnail'] as const) {
        const value = row[kind];
        if (!(value instanceof Uint8Array)) continue;
        const data = store.storedData(value);
        files.set(imageKey(row.contactId, kind), data);
        records.push({
          contactId: row.contactId,
          kind,
          storage: data.storage,
          externalId: data.storage === 'external' ? data.id : null,
          byteLength:
            data.storage === 'inline'
              ? data.bytes.length
              : (await stat(data.path)).size,
          sha256: await sha256(data),
        });
      }
    return records;
  }
}

function contactSelection(store: AddressBookStore, scope: ImportScope) {
  if (scope.collectionIds === undefined) return () => true;
  const containers = new Set<unknown>(
    store
      .all(definitions.containers.sql)
      .filter((row) => selected(scope.collectionIds, row.id))
      .map((row) => row.id),
  );
  const contacts = new Set<unknown>(
    store
      .all(definitions.contacts.sql)
      .filter((row) => containers.has(row.containerId))
      .map((row) => row.id),
  );
  const groups = new Set<unknown>(
    store
      .all(definitions.groups.sql)
      .filter((row) => containers.has(row.containerId))
      .map((row) => row.id),
  );
  const records = new Set<unknown>([...containers, ...contacts, ...groups]);
  return (name: StreamName, row: Record<string, unknown>): boolean => {
    if (name === 'containers') return containers.has(row.id);
    if (name === 'contacts') return contacts.has(row.id);
    if (name === 'groups') return groups.has(row.id);
    return (
      (!('contactId' in row) || contacts.has(row.contactId)) &&
      (!('groupId' in row) || groups.has(row.groupId)) &&
      (!('parentGroupId' in row) || groups.has(row.parentGroupId)) &&
      (!('childGroupId' in row) || groups.has(row.childGroupId)) &&
      (!('recordId' in row) || records.has(row.recordId))
    );
  };
}
