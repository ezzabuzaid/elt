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
  TeamsStore,
  TeamsUnavailableError,
} from '@workspace/sdk-microsoft-teams';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import { AccountsStream } from './streams/accounts-stream.ts';
import { ActivitiesStream } from './streams/activities-stream.ts';
import { CallLogsStream } from './streams/call-logs-stream.ts';
import { CallParticipantsStream } from './streams/call-participants-stream.ts';
import { ConversationMembersStream } from './streams/conversation-members-stream.ts';
import { ConversationsStream } from './streams/conversations-stream.ts';
import { FolderConversationsStream } from './streams/folder-conversations-stream.ts';
import { FoldersStream } from './streams/folders-stream.ts';
import { InstalledAppsStream } from './streams/installed-apps-stream.ts';
import { MeetingAttendeesStream } from './streams/meeting-attendees-stream.ts';
import { MeetingsStream } from './streams/meetings-stream.ts';
import { MessageFilesStream } from './streams/message-files-stream.ts';
import { MessageLinksStream } from './streams/message-links-stream.ts';
import { MessageMentionsStream } from './streams/message-mentions-stream.ts';
import { MessageQuotesStream } from './streams/message-quotes-stream.ts';
import { MessageReactionsStream } from './streams/message-reactions-stream.ts';
import { MessagesStream } from './streams/messages-stream.ts';
import { PeopleStream } from './streams/people-stream.ts';
import { PinsStream } from './streams/pins-stream.ts';
import { SavedMessagesStream } from './streams/saved-messages-stream.ts';
import { SearchesStream } from './streams/searches-stream.ts';
import { TeamsScan } from './teams-scan.ts';
import type { TeamsReader } from './teams-stream.ts';

const readers = {
  accounts: new AccountsStream(),
  conversations: new ConversationsStream(),
  conversationMembers: new ConversationMembersStream(),
  messages: new MessagesStream(),
  messageReactions: new MessageReactionsStream(),
  messageMentions: new MessageMentionsStream(),
  messageFiles: new MessageFilesStream(),
  messageLinks: new MessageLinksStream(),
  messageQuotes: new MessageQuotesStream(),
  pins: new PinsStream(),
  callLogs: new CallLogsStream(),
  callParticipants: new CallParticipantsStream(),
  activities: new ActivitiesStream(),
  savedMessages: new SavedMessagesStream(),
  people: new PeopleStream(),
  meetings: new MeetingsStream(),
  meetingAttendees: new MeetingAttendeesStream(),
  folders: new FoldersStream(),
  folderConversations: new FolderConversationsStream(),
  installedApps: new InstalledAppsStream(),
  searches: new SearchesStream(),
} satisfies Record<string, TeamsReader>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);
const readersByName = new Map<string, TeamsReader>(
  Object.values(readers).map((reader) => [reader.name, reader]),
);
// How often a watch checks whether the web client wrote its caches.
const pollIntervalMs = 1000;

// The version of the store: it changes whenever the web client writes its
// caches.
class StoreVersion extends Gauge<string> {
  readonly #store: TeamsStore;

  constructor(store: TeamsStore) {
    super();
    this.#store = store;
  }

  protected async read() {
    return this.#store.version();
  }
}

// Reads what the Microsoft Teams app keeps on this Mac, from its own store,
// without Microsoft Graph, a token or the network.
export class TeamsSource extends Source<TeamsScan> {
  readonly identity = 'microsoft-teams';
  protected readonly catalog = catalog;
  readonly accounts = catalog.get(readers.accounts.name);
  readonly conversations = catalog.get(readers.conversations.name);
  readonly conversationMembers = catalog.get(readers.conversationMembers.name);
  readonly messages = catalog.get(readers.messages.name);
  readonly messageReactions = catalog.get(readers.messageReactions.name);
  readonly messageMentions = catalog.get(readers.messageMentions.name);
  readonly messageFiles = catalog.get(readers.messageFiles.name);
  readonly messageLinks = catalog.get(readers.messageLinks.name);
  readonly messageQuotes = catalog.get(readers.messageQuotes.name);
  readonly pins = catalog.get(readers.pins.name);
  readonly callLogs = catalog.get(readers.callLogs.name);
  readonly callParticipants = catalog.get(readers.callParticipants.name);
  readonly activities = catalog.get(readers.activities.name);
  readonly savedMessages = catalog.get(readers.savedMessages.name);
  readonly people = catalog.get(readers.people.name);
  readonly meetings = catalog.get(readers.meetings.name);
  readonly meetingAttendees = catalog.get(readers.meetingAttendees.name);
  readonly folders = catalog.get(readers.folders.name);
  readonly folderConversations = catalog.get(readers.folderConversations.name);
  readonly installedApps = catalog.get(readers.installedApps.name);
  readonly searches = catalog.get(readers.searches.name);

  readonly directory: string;
  readonly scope: ImportScope;
  readonly #store: TeamsStore;

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
    this.#store = new TeamsStore(directory);
    Object.freeze(this);
  }

  protected override async open(): Promise<TeamsScan> {
    return new TeamsScan(await this.#store.clients(), this.scope);
  }

  protected override readonly configErrors = [TeamsUnavailableError];

  override coverage(_stream: Stream): ExtractionCoverage {
    return {
      description:
        'What the Microsoft Teams app keeps on this Mac for each signed-in work or school account: all its conversations, members and folders; only the messages, call history and activity the app has loaded; the people it has looked up; and the meetings of a few weeks around today.',
      selection: this.scope,
    };
  }

  // Teams' web client writes its caches only while the app runs, so the
  // store is current only as of its last write.
  override async currentAsOf(): Promise<Date> {
    return this.#store.lastWrite();
  }

  // The web client writes its caches as it works, so a write wakes every
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
    scan: TeamsScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === undefined)
      throw new Error(`Microsoft Teams has no stream ${stream.name}`);
    const records = reader.read(scan);
    yield* diffSnapshot(
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
  }
}
