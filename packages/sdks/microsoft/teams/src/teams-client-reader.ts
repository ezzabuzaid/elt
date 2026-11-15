import type {
  IndexedDBDatabase,
  IndexedDBRecord,
} from '@eltjs/codec-chromium-indexeddb';

import { readConversation } from './conversations.ts';
import { readActivity, readCallLog, readSaved } from './feeds.ts';
import { Fields } from './fields.ts';
import { readFolder } from './folders.ts';
import {
  readAppDefinition,
  readAppScope,
  readInstalledApps,
} from './installed-apps.ts';
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
  const messages: TeamsMessage[] = [];
  const callLogs: TeamsCallLog[] = [];
  const activities: TeamsActivity[] = [];
  const savedMessages: TeamsSavedMessage[] = [];
  const chains = [
    ...replyChains(databases.get('replychain-manager')).map((chain) => ({
      store: 'replychain-manager/replychains',
      chain,
    })),
    ...records('streams-replychain-manager', 'saved').map((chain) => ({
      store: 'streams-replychain-manager/saved',
      chain,
    })),
  ];
  // A chain record's key is its conversation and its first message,
  // [conversationId, replyChainId].
  for (const { store, chain } of chains) {
    const conversationId = chain.requiredString('conversationId');
    const recordId = chain.requiredText('replyChainId');
    const feed = conversationId.slice('48:'.length);
    for (const [entry, fields] of chain.entries('messageMap')) {
      const place = { store, conversationId, recordId, entry };
      let described = false;
      if (conversationId === '48:calllogs') {
        described = push(callLogs, readCallLog(fields, place));
      } else if (
        conversationId === '48:notifications' ||
        conversationId === '48:annotations'
      ) {
        described = push(activities, readActivity(fields, place, feed, read));
      } else if (
        conversationId === '48:saved' ||
        conversationId === '48:starred'
      ) {
        described = push(savedMessages, readSaved(fields, place, feed));
      }
      if (!described) messages.push(readMessage(fields, place));
    }
  }
  // A conversation keeps a copy of its newest message, and of its newest that
  // is not a membership or topic change, whether or not their chains are
  // cached. A Viva Engage community keeps a placeholder there, with no type,
  // sender or content, for a post that Engage holds.
  const conversations = records('conversation-manager', 'conversations');
  for (const conversation of conversations) {
    const conversationId = conversation.requiredString('id');
    if (feeds.has(conversationId)) continue;
    for (const entry of ['lastMessage', 'lastNonTMMessage']) {
      const last = conversation.object(entry);
      if (last === null || !last.has('messagetype')) continue;
      messages.push(
        readLastMessage(last, {
          store: 'conversation-manager/conversations',
          conversationId,
          recordId: conversationId,
          entry,
        }),
      );
    }
  }
  const managers = [
    [
      'user-installed-apps-manager',
      'user-app-entitlements',
      'user-app-definitions',
    ],
    ['chat-installed-apps-manager', 'app-entitlements', 'app-definitions'],
    ['team-installed-apps-manager', 'app-entitlements', 'app-definitions'],
  ] as const;
  const entitlements = managers.flatMap(([manager, store]) =>
    records(manager, store).flatMap((fields) => {
      const scope = readAppScope(fields);
      return scope === null
        ? []
        : [{ store: `${manager}/${store}`, fields, scope }];
    }),
  );
  const appScopes = new Set(
    entitlements.map(
      ({ store, fields }) => `${store}\n${fields.requiredString('cacheKey')}`,
    ),
  );
  return {
    account,
    conversations: conversations.map(readConversation),
    messages,
    callLogs,
    activities,
    people: records('profiles', 'profiles').map(readPerson),
    meetings: records('calendar', 'calendar').map(readMeeting),
    folders: records('conversation-folder-manager', 'folders').map(readFolder),
    savedMessages,
    installedApps: entitlements.flatMap(({ store, fields, scope }) =>
      readInstalledApps(fields, store, scope),
    ),
    appDefinitions: managers.flatMap(([manager, , store]) =>
      records(manager, store).flatMap((fields) => {
        const definition = readAppDefinition(fields, `${manager}/${store}`);
        return definition === null ? [] : [definition];
      }),
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
    holdsApps: (store, cacheKey) => appScopes.has(`${store}\n${cacheKey}`),
  };
}

// The object stores that hold the reply chains: replychains, and each later
// generation of it, such as replychains-2.
const replyChainStore = /^replychains(?:-(\d+))?$/;

// The reply chains of the newest generation of their object store. Teams
// moves each chain to the next generation and writes there from then on, and
// it leaves in the old one what that held at the move, also messages that it
// never sent.
function replyChains(database: IndexedDBDatabase | undefined): Fields[] {
  const [newest] = (database?.objectStores ?? [])
    .flatMap(({ name }) => {
      const generation = replyChainStore.exec(name);
      return generation === null
        ? []
        : [{ name, number: Number(generation[1] ?? 1) }];
    })
    .toSorted((a, b) => b.number - a.number);
  return newest === undefined ? [] : stored(database, newest.name);
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
