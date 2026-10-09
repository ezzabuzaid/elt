import { mkdtempDisposable, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setInterval } from 'node:timers/promises';

import type {
  CopyConfiguration,
  ExtractionCoverage,
  FailureType,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Catalog, Source, diffSnapshot } from '@workspace/elt';
import {
  ContactsStore,
  ContactsUnavailableError,
  addressBookDirectory,
} from '@workspace/sdk-apple-contacts';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import { localAppleStoreCoverage } from '@workspace/source-apple-macos/local-apple-store-coverage';

import type { ContactsReader } from './apple-contacts-stream.ts';
import { ContactsScan, imageKey } from './contacts-scan.ts';
import { AddressingGrammarsStream } from './streams/addressing-grammars-stream.ts';
import { AlertTonesStream } from './streams/alert-tones-stream.ts';
import { AlternateBirthdaysStream } from './streams/alternate-birthdays-stream.ts';
import { CalendarUrisStream } from './streams/calendar-uris-stream.ts';
import { ContactDatesStream } from './streams/contact-dates-stream.ts';
import { ContactsStream } from './streams/contacts-stream.ts';
import { ContainersStream } from './streams/containers-stream.ts';
import { CustomPropertyValuesStream } from './streams/custom-property-values-stream.ts';
import { DistributionListConfigsStream } from './streams/distribution-list-configs-stream.ts';
import { EmailAddressesStream } from './streams/email-addresses-stream.ts';
import { GroupMembersStream } from './streams/group-members-stream.ts';
import { GroupSubgroupsStream } from './streams/group-subgroups-stream.ts';
import { GroupsStream } from './streams/groups-stream.ts';
import { ImagesStream } from './streams/images-stream.ts';
import { LikenessesStream } from './streams/likenesses-stream.ts';
import { MessagingAddressesStream } from './streams/messaging-addresses-stream.ts';
import { NotesStream } from './streams/notes-stream.ts';
import { PhoneNumbersStream } from './streams/phone-numbers-stream.ts';
import { PostalAddressesStream } from './streams/postal-addresses-stream.ts';
import { RelatedNamesStream } from './streams/related-names-stream.ts';
import { RemoteLocationsStream } from './streams/remote-locations-stream.ts';
import { SocialProfilesStream } from './streams/social-profiles-stream.ts';
import { UnknownPropertiesStream } from './streams/unknown-properties-stream.ts';
import { UrlAddressesStream } from './streams/url-addresses-stream.ts';

const readers = {
  containers: new ContainersStream(),
  groups: new GroupsStream(),
  groupMembers: new GroupMembersStream(),
  groupSubgroups: new GroupSubgroupsStream(),
  contacts: new ContactsStream(),
  notes: new NotesStream(),
  alternateBirthdays: new AlternateBirthdaysStream(),
  phoneNumbers: new PhoneNumbersStream(),
  emailAddresses: new EmailAddressesStream(),
  postalAddresses: new PostalAddressesStream(),
  urlAddresses: new UrlAddressesStream(),
  socialProfiles: new SocialProfilesStream(),
  messagingAddresses: new MessagingAddressesStream(),
  relatedNames: new RelatedNamesStream(),
  contactDates: new ContactDatesStream(),
  calendarUris: new CalendarUrisStream(),
  addressingGrammars: new AddressingGrammarsStream(),
  likenesses: new LikenessesStream(),
  alertTones: new AlertTonesStream(),
  customPropertyValues: new CustomPropertyValuesStream(),
  remoteLocations: new RemoteLocationsStream(),
  unknownProperties: new UnknownPropertiesStream(),
  distributionListConfigs: new DistributionListConfigsStream(),
  images: new ImagesStream(),
} satisfies Record<string, ContactsReader>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);
const readersByName = new Map<string, ContactsReader>(
  Object.values(readers).map((reader) => [reader.name, reader]),
);

// How often a watch checks the stores for commits.
const pollIntervalMs = 1000;

// Reads Contacts' own Core Data stores, one per account, so Contacts.app
// need not run and no Contacts.framework entitlement is needed for notes.
export class AppleContactsSource extends Source<ContactsScan> {
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly containers = readers.containers.describe();
  readonly groups = readers.groups.describe();
  readonly groupMembers = readers.groupMembers.describe();
  readonly groupSubgroups = readers.groupSubgroups.describe();
  readonly contacts = readers.contacts.describe();
  readonly notes = readers.notes.describe();
  readonly alternateBirthdays = readers.alternateBirthdays.describe();
  readonly phoneNumbers = readers.phoneNumbers.describe();
  readonly emailAddresses = readers.emailAddresses.describe();
  readonly postalAddresses = readers.postalAddresses.describe();
  readonly urlAddresses = readers.urlAddresses.describe();
  readonly socialProfiles = readers.socialProfiles.describe();
  readonly messagingAddresses = readers.messagingAddresses.describe();
  readonly relatedNames = readers.relatedNames.describe();
  readonly contactDates = readers.contactDates.describe();
  readonly calendarUris = readers.calendarUris.describe();
  readonly addressingGrammars = readers.addressingGrammars.describe();
  readonly likenesses = readers.likenesses.describe();
  readonly alertTones = readers.alertTones.describe();
  readonly customPropertyValues = readers.customPropertyValues.describe();
  readonly remoteLocations = readers.remoteLocations.describe();
  readonly unknownProperties = readers.unknownProperties.describe();
  readonly distributionListConfigs = readers.distributionListConfigs.describe();
  readonly images = readers.images.describe();

  readonly directory: string;
  readonly scope: ImportScope;
  readonly #store: ContactsStore;

  constructor(directory = addressBookDirectory, scope: ImportScope = {}) {
    super();
    this.directory = directory;
    this.scope = scope;
    this.#store = new ContactsStore(directory);
    this.identity = `apple-contacts:${directory}`;
    Object.freeze(this);
  }

  protected override async open(): Promise<ContactsScan> {
    return new ContactsScan(await this.#store.open(), this.scope);
  }

  override failureType(error: unknown): FailureType {
    return error instanceof ContactsUnavailableError ? 'config' : 'system';
  }

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using version = this.#store.version();
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
    scan: ContactsScan,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === undefined)
      throw new TypeError(`Contacts has no stream ${stream.name}`);
    const records = await reader.read(scan);
    const messages =
      configuration.syncMode === 'incremental'
        ? diffSnapshot(stream, records, state)
        : records.map((data) => ({ stream: stream.name, data }));
    if (configuration.fileReads.length === 0 || reader !== readers.images) {
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
      const data = scan.images.get(
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
}
