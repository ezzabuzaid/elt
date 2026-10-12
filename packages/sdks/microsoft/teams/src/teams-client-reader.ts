import type {
  IndexedDBDatabase,
  IndexedDBRecord,
} from '@workspace/codec-chromium-indexeddb';

import { readConversation } from './conversations.ts';
import { readActivity, readCallLog, readSaved } from './feeds.ts';
import { Fields } from './fields.ts';
import { readFolder } from './folders.ts';
import { readAppScope, readInstalledApps } from './installed-apps.ts';
import { readMeeting } from './meetings.ts';
import { readLastMessage, readMessage } from './messages.ts';
import { readPerson } from './people.ts';
import { SyncWindows } from './sync-windows.ts';
import type {
  TeamsAccount,
  TeamsActivity,
  TeamsCallLog,
  TeamsClient,
  TeamsMessage,
  TeamsSavedMessage,
} from './teams-client.ts';

// The client's own lists, kept as conversations whose messages describe
// something elsewhere. Followed threads and mentions repeat what the
// conversations and the activity feed hold.
const feeds = new Set([
  '48:calllogs',
  '48:notifications',
  '48:annotations',
  '48:saved',
  '48:starred',
  '48:threads',
  '48:mentions',
]);

// One account's databases, by the manager that owns each:
// Teams:<manager>:react-web-client:<tenant>:<user>:<locale>.
export function readTeamsClient(
  account: TeamsAccount,
  databases: ReadonlyMap<string, IndexedDBDatabase>,
): TeamsClient {
  const records = (manager: string, store: string): Fields[] =>
    stored(databases.get(manager), store);
  const windows = new SyncWindows(records('syncstate-manager', 'syncstates'));
  const read = new Map(
    records('activity-manager', 'feed-items').map((item) => [
      item.requiredString('messageId'),
      item.boolean('isRead'),
    ]),
  );
  const messages = new Map<string, TeamsMessage>();
  const callLogs: TeamsCallLog[] = [];
  const activities: TeamsActivity[] = [];
  const savedMessages: TeamsSavedMessage[] = [];
  const chains = [
    ...records('replychain-manager', 'replychains'),
    ...records('streams-replychain-manager', 'saved'),
  ];
  for (const chain of chains) {
    for (const [, fields] of chain.entries('messageMap')) {
      const conversationId = fields.requiredString('conversationId');
      const feed = conversationId.slice('48:'.length);
      let described = false;
      if (conversationId === '48:calllogs') {
        described = push(callLogs, readCallLog(fields));
      } else if (
        conversationId === '48:notifications' ||
        conversationId === '48:annotations'
      ) {
        described = push(activities, readActivity(fields, feed, read));
      } else if (
        conversationId === '48:saved' ||
        conversationId === '48:starred'
      ) {
        described = push(savedMessages, readSaved(fields, feed));
      }
      if (described) continue;
      const message = readMessage(fields);
      messages.set(key(message), message);
    }
  }
  // A conversation keeps its newest message, and its newest that is not a
  // membership or topic change, whether or not their chains are cached. A
  // Viva Engage community keeps a placeholder there, with no type, sender or
  // content, for a post that Engage holds.
  const conversations = records('conversation-manager', 'conversations');
  for (const conversation of conversations) {
    const id = conversation.requiredString('id');
    if (feeds.has(id)) continue;
    for (const name of ['lastMessage', 'lastNonTMMessage']) {
      const last = conversation.object(name);
      if (last === null || !last.has('messagetype')) continue;
      const message = readLastMessage(last, id);
      if (!messages.has(key(message))) messages.set(key(message), message);
    }
  }
  const definitions = new Map(
    [
      ...records('user-installed-apps-manager', 'user-app-definitions'),
      ...records('chat-installed-apps-manager', 'app-definitions'),
      ...records('team-installed-apps-manager', 'app-definitions'),
    ].flatMap((definition) => {
      const item = definition.object('item');
      return item === null
        ? []
        : [[definition.requiredString('appId'), item] as const];
    }),
  );
  const entitlements = [
    ...records('user-installed-apps-manager', 'user-app-entitlements'),
    ...records('chat-installed-apps-manager', 'app-entitlements'),
    ...records('team-installed-apps-manager', 'app-entitlements'),
  ].flatMap((fields) => {
    const scope = readAppScope(fields);
    return scope === null ? [] : [{ fields, scope }];
  });
  const appScopes = new Set(
    entitlements.map(({ scope }) => `${scope.scope}\n${scope.scopeId}`),
  );
  return {
    account,
    conversations: conversations.map(readConversation),
    messages: [...messages.values()],
    callLogs,
    activities,
    people: records('profiles', 'profiles').map(readPerson),
    meetings: records('calendar', 'calendar').map(readMeeting),
    folders: records('conversation-folder-manager', 'folders').map(readFolder),
    savedMessages,
    installedApps: entitlements.flatMap(({ fields, scope }) =>
      readInstalledApps(fields, scope, definitions),
    ),
    searches: records('search-history-manager', 'searchhistory')
      .filter((entry) => entry.string('entityType') === 'SEARCH')
      .flatMap((entry) => {
        const query = entry.object('autoSuggestEntity')?.string('searchQuery');
        return query === null || query === undefined
          ? []
          : [
              {
                id: entry.requiredString('uniqueId'),
                query,
                searchedAt: entry.milliseconds('lastClickedTime'),
              },
            ];
      }),
    holds: (conversationId, threadId, messageId) =>
      windows.holds(conversationId, threadId, messageId),
    holdsApps: (scope, scopeId) => appScopes.has(`${scope}\n${scopeId}`),
  };
}

function stored(
  database: IndexedDBDatabase | undefined,
  name: string,
): Fields[] {
  const store = database?.objectStores.find((store) => store.name === name);
  return (store?.records ?? []).map(
    ({ key, value }: IndexedDBRecord) =>
      new Fields(value, `${database?.name}/${name}`, JSON.stringify(key)),
  );
}

function push<T>(list: T[], item: T | null): boolean {
  if (item === null) return false;
  list.push(item);
  return true;
}

function key({ conversationId, id }: TeamsMessage): string {
  return `${conversationId}\n${id}`;
}
