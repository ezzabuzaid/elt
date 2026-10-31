import { mkdtempDisposable, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pollChanges } from '@zukhruf/async';
import { ClosedWorld } from '@zukhruf/snapshot-differential';

import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Catalog, Source, diffSnapshot } from '@workspace/elt';
import {
  ContactsStore,
  ContactsUnavailableError,
  macRegion,
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
  readonly identity = 'apple-contacts';
  protected readonly catalog = catalog;
  readonly containers = catalog.get(readers.containers.name);
  readonly groups = catalog.get(readers.groups.name);
  readonly groupMembers = catalog.get(readers.groupMembers.name);
  readonly groupSubgroups = catalog.get(readers.groupSubgroups.name);
  readonly contacts = catalog.get(readers.contacts.name);
  readonly notes = catalog.get(readers.notes.name);
  readonly alternateBirthdays = catalog.get(readers.alternateBirthdays.name);
  readonly phoneNumbers = catalog.get(readers.phoneNumbers.name);
  readonly emailAddresses = catalog.get(readers.emailAddresses.name);
  readonly postalAddresses = catalog.get(readers.postalAddresses.name);
  readonly urlAddresses = catalog.get(readers.urlAddresses.name);
  readonly socialProfiles = catalog.get(readers.socialProfiles.name);
  readonly messagingAddresses = catalog.get(readers.messagingAddresses.name);
  readonly relatedNames = catalog.get(readers.relatedNames.name);
  readonly contactDates = catalog.get(readers.contactDates.name);
  readonly calendarUris = catalog.get(readers.calendarUris.name);
  readonly addressingGrammars = catalog.get(readers.addressingGrammars.name);
  readonly likenesses = catalog.get(readers.likenesses.name);
  readonly alertTones = catalog.get(readers.alertTones.name);
  readonly customPropertyValues = catalog.get(
    readers.customPropertyValues.name,
  );
  readonly remoteLocations = catalog.get(readers.remoteLocations.name);
  readonly unknownProperties = catalog.get(readers.unknownProperties.name);
  readonly distributionListConfigs = catalog.get(
    readers.distributionListConfigs.name,
  );
  readonly images = catalog.get(readers.images.name);

  readonly directory: string;
  readonly scope: ImportScope;
  readonly #preferences: string;
  readonly #store: ContactsStore;

  // preferences: the global preferences that hold the Mac's region.
  constructor({
    directory,
    preferences,
    scope = {},
  }: {
    directory: string;
    preferences: string;
    scope?: ImportScope;
  }) {
    super();
    this.directory = directory;
    this.scope = scope;
    this.#preferences = preferences;
    this.#store = new ContactsStore(directory);
    Object.freeze(this);
  }

  protected override async open(): Promise<ContactsScan> {
    const region = await macRegion(this.#preferences);
    return new ContactsScan(await this.#store.open(), this.scope, region);
  }

  protected override readonly configErrors = [ContactsUnavailableError];

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  override async currentAsOf() {
    return null;
  }

  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using version = this.#store.version();
    for await (const changed of pollChanges(
      new Map([['version', async () => version.current]]),
      { interval: pollIntervalMs, signal },
    ))
      yield changed.size > 0 ? streams : [];
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: ContactsScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === undefined)
      throw new TypeError(`Contacts has no stream ${stream.name}`);
    const records = reader.read(scan);
    const messages = diffSnapshot(configuration, records, state, {
      policy: new ClosedWorld(),
      signal,
    });
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
