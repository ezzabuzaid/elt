import { setInterval } from 'node:timers/promises';

import {
  ClosedWorld,
  type DeletionPolicy,
  Retention,
} from '@zukhruf/snapshot-differential';

import {
  Catalog,
  type CopyConfiguration,
  type ExtractionCoverage,
  type FailureType,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  type Stream,
  diffSnapshot,
} from '@workspace/elt';
import {
  WhatsApp,
  type WhatsAppStore,
  WhatsAppUnavailableError,
  type WhatsAppVersion,
  whatsappContainer,
} from '@workspace/sdk-whatsapp-desktop';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import { BlockedContactsStream } from './streams/blocked-contacts-stream.ts';
import { BusinessBotPromptsStream } from './streams/business-bot-prompts-stream.ts';
import { BusinessCategoriesStream } from './streams/business-categories-stream.ts';
import { BusinessHoursStream } from './streams/business-hours-stream.ts';
import { BusinessProfilesStream } from './streams/business-profiles-stream.ts';
import { BusinessServiceAreasStream } from './streams/business-service-areas-stream.ts';
import { BusinessVerifiedNamesStream } from './streams/business-verified-names-stream.ts';
import { CallParticipantsStream } from './streams/call-participants-stream.ts';
import { CallsStream } from './streams/calls-stream.ts';
import { ChangedNumbersStream } from './streams/changed-numbers-stream.ts';
import { ChatPushConfigsStream } from './streams/chat-push-configs-stream.ts';
import { ChatsStream } from './streams/chats-stream.ts';
import { ContactsStream } from './streams/contacts-stream.ts';
import { DisappearingModesStream } from './streams/disappearing-modes-stream.ts';
import { FavoriteStickersStream } from './streams/favorite-stickers-stream.ts';
import { GroupMembersChangesStream } from './streams/group-members-changes-stream.ts';
import { GroupMembersStream } from './streams/group-members-stream.ts';
import { LinkedProfilesStream } from './streams/linked-profiles-stream.ts';
import { MessageAssociationsStream } from './streams/message-associations-stream.ts';
import { MessageDataItemsStream } from './streams/message-data-items-stream.ts';
import { MessageReactionCountsStream } from './streams/message-reaction-counts-stream.ts';
import { MessageReactionsStream } from './streams/message-reactions-stream.ts';
import { MessageReceiptsStream } from './streams/message-receipts-stream.ts';
import { MessagesStream } from './streams/messages-stream.ts';
import { PrivacySettingsStream } from './streams/privacy-settings-stream.ts';
import { ProfilePicturesStream } from './streams/profile-pictures-stream.ts';
import { PushNamesStream } from './streams/push-names-stream.ts';
import { RecentStickersStream } from './streams/recent-stickers-stream.ts';
import { StatusesStream } from './streams/statuses-stream.ts';
import { StickerPacksStream } from './streams/sticker-packs-stream.ts';
import { StickersStream } from './streams/stickers-stream.ts';
import { UsersStream } from './streams/users-stream.ts';
import { WhatsAppScan } from './whatsapp-scan.ts';
import type { WhatsAppReader } from './whatsapp-stream.ts';

const readers = {
  chats: new ChatsStream(),
  messages: new MessagesStream(),
  messageReceipts: new MessageReceiptsStream(),
  messageReactions: new MessageReactionsStream(),
  messageReactionCounts: new MessageReactionCountsStream(),
  messageDataItems: new MessageDataItemsStream(),
  messageAssociations: new MessageAssociationsStream(),
  groupMembers: new GroupMembersStream(),
  groupMembersChanges: new GroupMembersChangesStream(),
  chatPushConfigs: new ChatPushConfigsStream(),
  pushNames: new PushNamesStream(),
  profilePictures: new ProfilePicturesStream(),
  blockedContacts: new BlockedContactsStream(),
  contacts: new ContactsStream(),
  users: new UsersStream(),
  calls: new CallsStream(),
  callParticipants: new CallParticipantsStream(),
  businessProfiles: new BusinessProfilesStream(),
  businessVerifiedNames: new BusinessVerifiedNamesStream(),
  businessCategories: new BusinessCategoriesStream(),
  businessHours: new BusinessHoursStream(),
  businessServiceAreas: new BusinessServiceAreasStream(),
  businessBotPrompts: new BusinessBotPromptsStream(),
  statuses: new StatusesStream(),
  stickerPacks: new StickerPacksStream(),
  stickers: new StickersStream(),
  favoriteStickers: new FavoriteStickersStream(),
  recentStickers: new RecentStickersStream(),
  privacySettings: new PrivacySettingsStream(),
  disappearingModes: new DisappearingModesStream(),
  linkedProfiles: new LinkedProfilesStream(),
  changedNumbers: new ChangedNumbersStream(),
} satisfies Record<string, WhatsAppReader>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);
const readersByName = new Map<string, WhatsAppReader>(
  Object.values(readers).map((reader) => [reader.name, reader]),
);

function readerOf(stream: Stream): WhatsAppReader {
  const reader = readersByName.get(stream.name);
  if (reader === undefined)
    throw new TypeError(`WhatsApp has no ${stream.name} stream`);
  return reader;
}

// How often a watch checks the stores for commits.
const pollIntervalMs = 1000;

// Reads what WhatsApp for Mac keeps on this Mac, from its own stores, without
// WhatsApp's servers, a session or the network.
export class WhatsAppDesktopSource extends Source<WhatsAppScan> {
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly chats = readers.chats.describe();
  readonly messages = readers.messages.describe();
  readonly messageReceipts = readers.messageReceipts.describe();
  readonly messageReactions = readers.messageReactions.describe();
  readonly messageReactionCounts = readers.messageReactionCounts.describe();
  readonly messageDataItems = readers.messageDataItems.describe();
  readonly messageAssociations = readers.messageAssociations.describe();
  readonly groupMembers = readers.groupMembers.describe();
  readonly groupMembersChanges = readers.groupMembersChanges.describe();
  readonly chatPushConfigs = readers.chatPushConfigs.describe();
  readonly pushNames = readers.pushNames.describe();
  readonly profilePictures = readers.profilePictures.describe();
  readonly blockedContacts = readers.blockedContacts.describe();
  readonly contacts = readers.contacts.describe();
  readonly users = readers.users.describe();
  readonly calls = readers.calls.describe();
  readonly callParticipants = readers.callParticipants.describe();
  readonly businessProfiles = readers.businessProfiles.describe();
  readonly businessVerifiedNames = readers.businessVerifiedNames.describe();
  readonly businessCategories = readers.businessCategories.describe();
  readonly businessHours = readers.businessHours.describe();
  readonly businessServiceAreas = readers.businessServiceAreas.describe();
  readonly businessBotPrompts = readers.businessBotPrompts.describe();
  readonly statuses = readers.statuses.describe();
  readonly stickerPacks = readers.stickerPacks.describe();
  readonly stickers = readers.stickers.describe();
  readonly favoriteStickers = readers.favoriteStickers.describe();
  readonly recentStickers = readers.recentStickers.describe();
  readonly privacySettings = readers.privacySettings.describe();
  readonly disappearingModes = readers.disappearingModes.describe();
  readonly linkedProfiles = readers.linkedProfiles.describe();
  readonly changedNumbers = readers.changedNumbers.describe();

  readonly container: string;
  readonly scope: ImportScope;
  readonly #whatsapp: WhatsApp;

  constructor(container = whatsappContainer, scope: ImportScope = {}) {
    super();
    this.container = container;
    this.scope = scope;
    this.#whatsapp = new WhatsApp(container);
    this.identity = `whatsapp-desktop:${container}`;
    Object.freeze(this);
  }

  protected override async open(
    streams: readonly Stream[],
  ): Promise<WhatsAppScan> {
    return WhatsAppScan.open(
      this.#whatsapp,
      new Set(streams.map((stream) => readerOf(stream).store)),
      this.scope,
    );
  }

  override failureType(error: unknown): FailureType {
    return error instanceof WhatsAppUnavailableError ? 'config' : 'system';
  }

  override coverage(_stream: Stream): ExtractionCoverage {
    return {
      description:
        'What WhatsApp for Mac keeps on this Mac: the chats and messages it has synced from the phone and received while running, with the files it downloaded. WhatsApp writes its chats and messages only while the app runs, and drops a contact’s status a day after it is posted. An import’s chats and dates narrow chats, messages and what hangs off them; the other streams are not narrowed.',
      selection: this.scope,
    };
  }

  // Each store the streams read reports its own commits.
  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using versions = new DisposableStack();
    const probes = new Map<WhatsAppStore, WhatsAppVersion>(
      [...new Set(streams.map((stream) => readerOf(stream).store))].map(
        (store) => [store, versions.use(this.#whatsapp.version(store))],
      ),
    );
    const seen = new Map(
      [...probes].map(([store, probe]) => [store, probe.current]),
    );
    yield streams;
    try {
      for await (const _ of setInterval(pollIntervalMs, undefined, {
        signal,
      })) {
        const changed = new Set<WhatsAppStore>();
        for (const [store, probe] of probes) {
          const current = probe.current;
          if (current === seen.get(store)) continue;
          seen.set(store, current);
          changed.add(store);
        }
        yield streams.filter((stream) => changed.has(readerOf(stream).store));
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) throw error;
    }
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: WhatsAppScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readerOf(stream);
    const records = reader.read(scan);
    const messages = diffSnapshot(configuration, records, state, {
      policy: policyFor(reader.horizon(scan)),
      signal,
    });
    for await (const message of messages) {
      if ('type' in message || configuration.fileReads.length === 0)
        yield message;
      else yield { ...message, file: reader.file(message.data, scan) };
    }
  }
}

// A stream WhatsApp expires keeps records from its horizon on; any other
// lists every record.
function policyFor(horizon: string | undefined): DeletionPolicy {
  return horizon === undefined ? new ClosedWorld() : new Retention(horizon);
}
