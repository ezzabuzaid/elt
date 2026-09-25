import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtempDisposable, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setInterval } from 'node:timers/promises';
import type {
  CopyConfiguration,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from 'elt';
import { Catalog, diffSnapshot, Source, validateRecords } from 'elt';
import {
  AddressBook,
  type AddressBookStore,
  AddressBookVersion,
  addressBookDirectory,
  type StoredData,
} from '../../platform/macos/address-book.ts';
import {
  definitions,
  recordFrom,
  requiredSchema,
  type StreamName,
  streams,
} from './contacts-streams.ts';

const catalog = new Catalog(Object.values(streams));

const imageKey = (contactId: unknown, kind: unknown) =>
  JSON.stringify([contactId, kind]);

async function sha256(data: StoredData): Promise<string> {
  const hash = createHash('sha256');
  if (data.storage === 'inline') hash.update(data.bytes);
  else
    for await (const chunk of createReadStream(data.path)) hash.update(chunk);
  return hash.digest('hex');
}

// Reads Contacts' own Core Data stores, one per account, so Contacts.app
// need not run and no Contacts.framework entitlement is needed for notes.
export class AppleContactsSource extends Source<AddressBook> {
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly containers = streams.containers;
  readonly groups = streams.groups;
  readonly groupMembers = streams.groupMembers;
  readonly groupSubgroups = streams.groupSubgroups;
  readonly contacts = streams.contacts;
  readonly notes = streams.notes;
  readonly alternateBirthdays = streams.alternateBirthdays;
  readonly phoneNumbers = streams.phoneNumbers;
  readonly emailAddresses = streams.emailAddresses;
  readonly postalAddresses = streams.postalAddresses;
  readonly urlAddresses = streams.urlAddresses;
  readonly socialProfiles = streams.socialProfiles;
  readonly messagingAddresses = streams.messagingAddresses;
  readonly relatedNames = streams.relatedNames;
  readonly contactDates = streams.contactDates;
  readonly calendarUris = streams.calendarUris;
  readonly addressingGrammars = streams.addressingGrammars;
  readonly likenesses = streams.likenesses;
  readonly alertTones = streams.alertTones;
  readonly customPropertyValues = streams.customPropertyValues;
  readonly remoteLocations = streams.remoteLocations;
  readonly unknownProperties = streams.unknownProperties;
  readonly distributionListConfigs = streams.distributionListConfigs;
  readonly images = streams.images;

  constructor(
    readonly directory = addressBookDirectory,
    // How often a watch checks the stores for commits.
    readonly pollIntervalMs = 1000,
  ) {
    super();
    this.identity = `apple-contacts:${directory}`;
    Object.freeze(this);
  }

  override session(): Promise<AddressBook> {
    return AddressBook.open(this.directory, requiredSchema);
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
      for await (const _ of setInterval(this.pollIntervalMs, undefined, {
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
    const name = stream.name as StreamName;
    const files = new Map<string, StoredData>();
    const rows = [];
    for (const store of book.stores)
      rows.push(
        ...(name === 'images'
          ? await this.#images(store, files)
          : store.all(definitions[name].sql).map((row) => {
              const record = recordFrom(name, row);
              if (name === 'containers') record.source = store.source;
              return record;
            })),
      );
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
  ): Promise<Record<string, unknown>[]> {
    const records: Record<string, unknown>[] = [];
    for (const row of store.all(definitions.images.sql))
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
