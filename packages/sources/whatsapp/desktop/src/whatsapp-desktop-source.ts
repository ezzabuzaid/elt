import {
  Catalog,
  type CopyConfiguration,
  type ExtractionCoverage,
  type PipelineClock,
  Source,
  type SourceMessage,
  type Stream,
} from '@workspace/elt';
import {
  StoreUnavailableError,
  WhatsApp,
  whatsappRunning,
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
  readonly identity = 'whatsapp-desktop';
  protected readonly catalog = catalog;
  readonly chats = catalog.get(readers.chats.name);
  readonly messages = catalog.get(readers.messages.name);
  readonly messageReceipts = catalog.get(readers.messageReceipts.name);
  readonly messageReactions = catalog.get(readers.messageReactions.name);
  readonly messageReactionCounts = catalog.get(
    readers.messageReactionCounts.name,
  );
  readonly messageDataItems = catalog.get(readers.messageDataItems.name);
  readonly messageAssociations = catalog.get(readers.messageAssociations.name);
  readonly groupMembers = catalog.get(readers.groupMembers.name);
  readonly groupMembersChanges = catalog.get(readers.groupMembersChanges.name);
  readonly chatPushConfigs = catalog.get(readers.chatPushConfigs.name);
  readonly pushNames = catalog.get(readers.pushNames.name);
  readonly profilePictures = catalog.get(readers.profilePictures.name);
  readonly blockedContacts = catalog.get(readers.blockedContacts.name);
  readonly contacts = catalog.get(readers.contacts.name);
  readonly users = catalog.get(readers.users.name);
  readonly calls = catalog.get(readers.calls.name);
  readonly callParticipants = catalog.get(readers.callParticipants.name);
  readonly businessProfiles = catalog.get(readers.businessProfiles.name);
  readonly businessVerifiedNames = catalog.get(
    readers.businessVerifiedNames.name,
  );
  readonly businessCategories = catalog.get(readers.businessCategories.name);
  readonly businessHours = catalog.get(readers.businessHours.name);
  readonly businessServiceAreas = catalog.get(
    readers.businessServiceAreas.name,
  );
  readonly businessBotPrompts = catalog.get(readers.businessBotPrompts.name);
  readonly statuses = catalog.get(readers.statuses.name);
  readonly stickerPacks = catalog.get(readers.stickerPacks.name);
  readonly stickers = catalog.get(readers.stickers.name);
  readonly favoriteStickers = catalog.get(readers.favoriteStickers.name);
  readonly recentStickers = catalog.get(readers.recentStickers.name);
  readonly privacySettings = catalog.get(readers.privacySettings.name);
  readonly disappearingModes = catalog.get(readers.disappearingModes.name);
  readonly linkedProfiles = catalog.get(readers.linkedProfiles.name);
  readonly changedNumbers = catalog.get(readers.changedNumbers.name);

  readonly container: string;
  readonly scope: ImportScope;
  readonly #whatsapp: WhatsApp;

  constructor({
    container,
    scope = {},
  }: {
    container: string;
    scope?: ImportScope;
  }) {
    super();
    this.container = container;
    this.scope = scope;
    this.#whatsapp = new WhatsApp(container);
    Object.freeze(this);
  }

  // The run starts now on the clock of the pipeline.
  protected override async open(
    streams: readonly Stream[],
    signal: AbortSignal | undefined,
    states: { get(stream: string): unknown },
    clock: PipelineClock,
  ): Promise<WhatsAppScan> {
    return WhatsAppScan.open(
      this.#whatsapp,
      new Set(streams.map((stream) => readerOf(stream).store)),
      this.scope,
      new Date(clock.Date.now()),
    );
  }

  protected override readonly configErrors = [StoreUnavailableError];

  override coverage(_stream: Stream): ExtractionCoverage {
    return {
      description:
        'What WhatsApp for Mac keeps on this Mac: the chats and messages it has synced from the phone and received while running, with the files it downloaded. WhatsApp writes its chats and messages only while the app runs, and drops a contact’s status a day after it is posted. An import’s chats and dates narrow chats, messages and what hangs off them; the other streams are not narrowed.',
      selection: this.scope,
    };
  }

  // WhatsApp writes its stores only while the app runs, so while it is
  // closed each store stays as of when the app last wrote it.
  override async currentAsOf(stream: Stream): Promise<Date | null> {
    return (await whatsappRunning())
      ? null
      : this.#whatsapp.lastWrite(readerOf(stream).store);
  }

  // Each store the streams read reports its own commits.
  override changeSignals(streams: readonly Stream[]) {
    return Map.groupBy(streams, (stream) => readerOf(stream).store)
      .entries()
      .map(([store, watched]) => ({
        gauge: this.#whatsapp.version(store),
        streams: watched,
        interval: pollIntervalMs,
        // A data_version read is local: a check that takes the whole interval
        // is stuck.
        timeout: pollIntervalMs,
      }));
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
    const messages = reader.changes(configuration, scan, state, signal);
    for await (const message of messages) {
      if ('type' in message || configuration.fileReads.length === 0)
        yield message;
      else yield { ...message, file: reader.file(message.data, scan) };
    }
  }
}
