import { setInterval } from 'node:timers/promises';

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
  SlackDesktopStore,
  SlackDesktopUnavailableError,
  slackDesktopDirectory,
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

// Reads what the Slack app keeps on this Mac, from its own store, without
// Slack's API, a token or the network.
export class SlackDesktopSource extends Source<SlackDesktopScan> {
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly workspaces = readers.workspaces.describe();
  readonly channels = readers.channels.describe();
  readonly channelMembers = readers.channelMembers.describe();
  readonly members = readers.members.describe();
  readonly bots = readers.bots.describe();
  readonly apps = readers.apps.describe();
  readonly messages = readers.messages.describe();
  readonly threadReplies = readers.threadReplies.describe();
  readonly messageAttachments = readers.messageAttachments.describe();
  readonly messageReactions = readers.messageReactions.describe();
  readonly messageFiles = readers.messageFiles.describe();
  readonly pins = readers.pins.describe();
  readonly files = readers.files.describe();
  readonly fileShares = readers.fileShares.describe();
  readonly listRecords = readers.listRecords.describe();
  readonly channelSections = readers.channelSections.describe();
  readonly channelSectionChannels = readers.channelSectionChannels.describe();
  readonly threadSubscriptions = readers.threadSubscriptions.describe();
  readonly preferences = readers.preferences.describe();
  readonly userGroupMemberships = readers.userGroupMemberships.describe();
  readonly downloads = readers.downloads.describe();

  readonly directory: string;
  readonly scope: ImportScope;
  readonly #store: SlackDesktopStore;

  constructor(directory = slackDesktopDirectory, scope: ImportScope = {}) {
    super();
    this.directory = directory;
    this.scope = scope;
    this.#store = new SlackDesktopStore(directory);
    this.identity = `slack-desktop:${directory}`;
    Object.freeze(this);
  }

  protected override async open(): Promise<SlackDesktopScan> {
    const [clients, downloads] = await Promise.allSettled([
      this.#store.clients(),
      this.#store.downloads(),
    ]);
    return new SlackDesktopScan(clients, downloads, this.scope);
  }

  override failureType(error: unknown): FailureType {
    return error instanceof SlackDesktopUnavailableError ? 'config' : 'system';
  }

  override coverage(_stream: Stream): ExtractionCoverage {
    return {
      description:
        'What the Slack app keeps on this Mac for each signed-in workspace: its channels, members and apps, only the messages the app has loaded, and the files it downloaded. A workspace appears once the app has saved it, every few minutes while it is open and when it quits.',
      selection: this.scope,
    };
  }

  // The app saves one record for all of a workspace, so a save wakes every
  // selected stream; the snapshot diff writes nothing for those that did not
  // change.
  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    let seen = this.#store.version();
    yield streams;
    try {
      for await (const _ of setInterval(pollIntervalMs, undefined, {
        signal,
      })) {
        const current = this.#store.version();
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
    scan: SlackDesktopScan,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === undefined)
      throw new Error(`Slack has no stream ${stream.name}`);
    const records = reader.read(scan);
    const messages =
      configuration.syncMode === 'full_refresh'
        ? records.map((data) => ({ stream: stream.name, data }))
        : diffSnapshot(
            stream,
            records,
            state,
            stream.emitsDeletes
              ? { covers: ({ key }) => reader.covers(scan, key) }
              : {},
          );
    for await (const message of messages)
      if ('type' in message || configuration.fileReads.length === 0)
        yield message;
      else yield { ...message, file: reader.file(message.data) };
  }
}
