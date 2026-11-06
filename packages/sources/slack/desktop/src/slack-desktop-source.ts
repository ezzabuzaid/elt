import { ChangeWatcher, Gauge } from '@zukhruf/async';
import { Coverage } from '@zukhruf/snapshot-differential';

import {
  Catalog,
  type CopyConfiguration,
  type ExtractionCoverage,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  type Stream,
  diffSnapshot,
} from '@workspace/elt';
import {
  SlackDesktopStore,
  SlackDesktopUnavailableError,
} from '@workspace/sdk-slack-desktop';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import { SlackDesktopScan } from './slack-desktop-scan.ts';
import type { SlackDesktopReader } from './slack-desktop-stream.ts';
import { AppsStream } from './streams/apps-stream.ts';
import { BotsStream } from './streams/bots-stream.ts';
import { ChannelMembersStream } from './streams/channel-members-stream.ts';
import { ChannelSectionChannelsStream } from './streams/channel-section-channels-stream.ts';
import { ChannelSectionsStream } from './streams/channel-sections-stream.ts';
import { ChannelsStream } from './streams/channels-stream.ts';
import { DownloadsStream } from './streams/downloads-stream.ts';
import { FileSharesStream } from './streams/file-shares-stream.ts';
import { FilesStream } from './streams/files-stream.ts';
import { ListRecordsStream } from './streams/list-records-stream.ts';
import { MembersStream } from './streams/members-stream.ts';
import { MessageAttachmentsStream } from './streams/message-attachments-stream.ts';
import { MessageFilesStream } from './streams/message-files-stream.ts';
import { MessageReactionsStream } from './streams/message-reactions-stream.ts';
import { MessagesStream } from './streams/messages-stream.ts';
import { PinsStream } from './streams/pins-stream.ts';
import { PreferencesStream } from './streams/preferences-stream.ts';
import { ThreadRepliesStream } from './streams/thread-replies-stream.ts';
import { ThreadSubscriptionsStream } from './streams/thread-subscriptions-stream.ts';
import { UserGroupMembershipsStream } from './streams/user-group-memberships-stream.ts';
import { WorkspacesStream } from './streams/workspaces-stream.ts';

const readers = {
  workspaces: new WorkspacesStream(),
  channels: new ChannelsStream(),
  channelMembers: new ChannelMembersStream(),
  members: new MembersStream(),
  bots: new BotsStream(),
  apps: new AppsStream(),
  messages: new MessagesStream(),
  threadReplies: new ThreadRepliesStream(),
  messageAttachments: new MessageAttachmentsStream(),
  messageReactions: new MessageReactionsStream(),
  messageFiles: new MessageFilesStream(),
  pins: new PinsStream(),
  files: new FilesStream(),
  fileShares: new FileSharesStream(),
  listRecords: new ListRecordsStream(),
  channelSections: new ChannelSectionsStream(),
  channelSectionChannels: new ChannelSectionChannelsStream(),
  threadSubscriptions: new ThreadSubscriptionsStream(),
  preferences: new PreferencesStream(),
  userGroupMemberships: new UserGroupMembershipsStream(),
  downloads: new DownloadsStream(),
} satisfies Record<string, SlackDesktopReader>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);
const readersByName = new Map<string, SlackDesktopReader>(
  Object.values(readers).map((reader) => [reader.name, reader]),
);
// How often a watch checks whether the app saved its state.
const pollIntervalMs = 1000;

// The version of the store: it changes whenever the app saves its state, a
// client's or its own.
class StoreVersion extends Gauge<string> {
  readonly #store: SlackDesktopStore;

  constructor(store: SlackDesktopStore) {
    super();
    this.#store = store;
  }

  protected async read() {
    return this.#store.version();
  }
}

// Reads what the Slack app keeps on this Mac, from its own store, without
// Slack's API, a token or the network.
export class SlackDesktopSource extends Source<SlackDesktopScan> {
  readonly identity = 'slack-desktop';
  protected readonly catalog = catalog;
  readonly workspaces = catalog.get(readers.workspaces.name);
  readonly channels = catalog.get(readers.channels.name);
  readonly channelMembers = catalog.get(readers.channelMembers.name);
  readonly members = catalog.get(readers.members.name);
  readonly bots = catalog.get(readers.bots.name);
  readonly apps = catalog.get(readers.apps.name);
  readonly messages = catalog.get(readers.messages.name);
  readonly threadReplies = catalog.get(readers.threadReplies.name);
  readonly messageAttachments = catalog.get(readers.messageAttachments.name);
  readonly messageReactions = catalog.get(readers.messageReactions.name);
  readonly messageFiles = catalog.get(readers.messageFiles.name);
  readonly pins = catalog.get(readers.pins.name);
  readonly files = catalog.get(readers.files.name);
  readonly fileShares = catalog.get(readers.fileShares.name);
  readonly listRecords = catalog.get(readers.listRecords.name);
  readonly channelSections = catalog.get(readers.channelSections.name);
  readonly channelSectionChannels = catalog.get(
    readers.channelSectionChannels.name,
  );
  readonly threadSubscriptions = catalog.get(readers.threadSubscriptions.name);
  readonly preferences = catalog.get(readers.preferences.name);
  readonly userGroupMemberships = catalog.get(
    readers.userGroupMemberships.name,
  );
  readonly downloads = catalog.get(readers.downloads.name);

  readonly directory: string;
  readonly scope: ImportScope;
  readonly #store: SlackDesktopStore;

  constructor({
    directory,
    scope = {},
  }: {
    directory: string;
    scope?: ImportScope;
  }) {
    super();
    this.directory = directory;
    this.scope = scope;
    this.#store = new SlackDesktopStore(directory);
    Object.freeze(this);
  }

  protected override async open(): Promise<SlackDesktopScan> {
    const [clients, downloads] = await Promise.allSettled([
      this.#store.clients(),
      this.#store.downloads(),
    ]);
    return new SlackDesktopScan(clients, downloads, this.scope);
  }

  protected override readonly configErrors = [SlackDesktopUnavailableError];

  override coverage(_stream: Stream): ExtractionCoverage {
    return {
      description:
        'What the Slack app keeps on this Mac for each signed-in workspace: its channels, members and apps, only the messages the app has loaded, and the files it downloaded. A workspace appears once the app has saved it, every few minutes while it is open and when it quits.',
      selection: this.scope,
    };
  }

  // Slack saves its state every few minutes while it runs and when it
  // quits, so the store is current only as of its last save.
  override async currentAsOf(): Promise<Date> {
    return this.#store.lastWrite();
  }

  // The app saves one record for all of a workspace, so a save wakes every
  // selected stream; the snapshot diff writes nothing for those that did not
  // change.
  protected override async *observe({
    streams,
    signal,
    clock,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    // A local read: a check that takes the whole interval is stuck.
    const watcher = new ChangeWatcher([new StoreVersion(this.#store)], {
      interval: pollIntervalMs,
      timeout: pollIntervalMs,
      clock,
    });
    for await (const outcomes of watcher.watch(signal))
      for (const outcome of outcomes.values()) {
        if (outcome.state === 'failed') throw outcome.error;
        yield outcome.state === 'changed' ? streams : [];
      }
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: SlackDesktopScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === undefined)
      throw new Error(`Slack has no stream ${stream.name}`);
    const records = reader.read(scan);
    const messages = diffSnapshot(
      configuration,
      records,
      state,
      stream.emitsDeletes
        ? {
            policy: new Coverage(({ key }) => reader.covers(scan, key)),
            signal,
          }
        : { signal },
    );
    for await (const message of messages)
      if ('type' in message || configuration.fileReads.length === 0)
        yield message;
      else yield { ...message, file: reader.file(message.data) };
  }
}
