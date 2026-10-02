import { mailDirectory } from 'apple/platform/macos/mail-store';
import { AppleBooksSource } from 'apple/sources/apple-books/apple-books-source';
import { AppleCalendarSource } from 'apple/sources/apple-calendar/apple-calendar-source';
import { AppleContactsSource } from 'apple/sources/apple-contacts/apple-contacts-source';
import {
  AppleMailSource,
  restrictedMailStreams,
} from 'apple/sources/apple-mail/apple-mail-source';
import { AppleMessagesSource } from 'apple/sources/apple-messages/apple-messages-source';
import { AppleNotesSource } from 'apple/sources/apple-notes/apple-notes-source';
import { AppleRemindersSource } from 'apple/sources/apple-reminders/apple-reminders-source';
import { AppleSafariSource } from 'apple/sources/apple-safari/apple-safari-source';
import type { ImportScope } from 'apple/sources/import-scope';
import type { Source } from 'elt';
import type { AppFacts } from 'import-store';

export const appNames = [
  'mail',
  'notes',
  'messages',
  'contacts',
  'calendar',
  'reminders',
  'safari',
  'books',
] as const;
export type App = (typeof appNames)[number];

type Row = Record<string, unknown>;
export type ChoiceRows = Record<string, Row[]>;

// A stream that lists accounts or collections a user chooses from.
export type Choice = {
  readonly stream: string;
  readonly scope: 'accountIds' | 'collectionIds';
  id(row: Row): string;
  label(row: Row, rows: ChoiceRows): string;
};

type AppDefinition = {
  readonly title: string;
  readonly choices: readonly Choice[];
  // For an app with no choices: the stream read to show its store opens. Its
  // rows are not returned.
  readonly probe?: string;
  // How dates select records, in the user's words; null when they cannot.
  readonly datedBy: string | null;
  // Whether macOS gates the app's store behind Full Disk Access.
  readonly fullDiskAccess: boolean;
  readonly permissions: string;
  readonly note?: string;
  // Streams whose rows cannot be attributed to a chosen account or collection.
  readonly unscoped?: readonly string[];
  // File streams that copy the app's own store rather than attachments; they
  // import metadata only, whatever the attachments choice.
  readonly storeCopies?: readonly string[];
  defaultScope?(): ImportScope;
  source(scope: ImportScope): Source;
};

// Every event from 2000 to a year ahead.
function calendarDefaults() {
  const end = new Date();
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  return { startAt: '2000-01-01T00:00:00.000Z', endAt: end.toISOString() };
}

const byId = (row: Row) => String(row.id);
const named = (row: Row) => String(row.name);
const accounts: Choice = {
  stream: 'accounts',
  scope: 'accountIds',
  id: byId,
  label: named,
};
// Collection names repeat across accounts, such as a Notes folder per account.
const collections = (stream: string): Choice => ({
  stream,
  scope: 'collectionIds',
  id: byId,
  label: (row, rows) => {
    const account = rows.accounts?.find(
      (candidate) => candidate.id === row.accountId,
    );
    return account === undefined
      ? named(row)
      : `${named(account)} / ${named(row)}`;
  },
});

// macOS lists the ChatGPT desktop app, which runs Codex, as ChatGPT.
const turnOnFullDiskAccess =
  'Turn on ChatGPT in System Settings > Privacy & Security > Full Disk Access, then quit and reopen ChatGPT. macOS does not ask for this access.';

export const apps: Record<App, AppDefinition> = {
  mail: {
    title: 'Mail',
    fullDiskAccess: true,
    choices: [
      {
        ...accounts,
        label: (row) => JSON.parse(String(row.properties)).name,
      },
      {
        stream: 'mailboxes',
        scope: 'collectionIds',
        id: byId,
        // A mailbox URL names its account as the host.
        label: (row, rows) => {
          const url = new URL(String(row.url));
          const account = rows.accounts?.find(
            (candidate) => candidate.id === url.hostname,
          );
          const path = decodeURIComponent(url.pathname.slice(1));
          return account === undefined
            ? path
            : `${JSON.parse(String(account.properties)).name} / ${path}`;
        },
      },
    ],
    datedBy: 'date received (date sent if missing)',
    permissions: `${turnOnFullDiskAccess} Allow ChatGPT to control Mail when macOS asks.`,
    unscoped: restrictedMailStreams,
    // Each message's raw .emlx; messageParts already holds its decoded text.
    storeCopies: ['messageFiles'],
    source: (scope) => new AppleMailSource(mailDirectory, scope),
  },
  notes: {
    title: 'Notes',
    fullDiskAccess: true,
    choices: [accounts, collections('folders')],
    datedBy: 'date last edited',
    permissions: `${turnOnFullDiskAccess} Open Notes to let it finish syncing iCloud changes.`,
    note: 'Exact containing folders; select descendants separately. Smart folders are saved searches and cannot be selected as containing folders.',
    source: (scope) => new AppleNotesSource({ scope }),
  },
  messages: {
    title: 'Messages',
    fullDiskAccess: true,
    choices: [
      {
        stream: 'chats',
        scope: 'collectionIds',
        id: (row) => String(row.guid),
        label: (row) => String(row.displayName || row.chatIdentifier),
      },
    ],
    datedBy: 'message date',
    permissions: `${turnOnFullDiskAccess} Only messages synced to this Mac can be imported.`,
    source: (scope) => new AppleMessagesSource(undefined, scope),
  },
  contacts: {
    title: 'Contacts',
    fullDiskAccess: false,
    choices: [{ ...accounts, stream: 'containers', scope: 'collectionIds' }],
    datedBy: null,
    permissions:
      'Allow ChatGPT when macOS asks for Contacts access, or turn it on in System Settings > Privacy & Security > Contacts. Full Disk Access for ChatGPT also works.',
    source: (scope) => new AppleContactsSource(undefined, scope),
  },
  calendar: {
    title: 'Calendar',
    fullDiskAccess: false,
    choices: [accounts, collections('calendars')],
    datedBy: 'event dates (events that overlap the range)',
    permissions:
      'Allow full Calendar access when macOS asks. Access can be changed under System Settings > Privacy & Security > Calendars.',
    defaultScope: calendarDefaults,
    source: (scope) =>
      new AppleCalendarSource({
        startAt: scope.startAt ?? calendarDefaults().startAt,
        endAt: scope.endAt ?? calendarDefaults().endAt,
        scope,
        attachments: async () => false,
      }),
  },
  reminders: {
    title: 'Reminders',
    fullDiskAccess: false,
    choices: [accounts, collections('lists')],
    datedBy: null,
    permissions:
      'Allow full Reminders access when macOS asks. Access can be changed under System Settings > Privacy & Security > Reminders.',
    source: (scope) => new AppleRemindersSource(scope),
  },
  safari: {
    title: 'Safari',
    fullDiskAccess: true,
    choices: [
      {
        stream: 'profiles',
        scope: 'collectionIds',
        id: byId,
        // Safari stores no name for the profile it starts with.
        label: (row) => String(row.title ?? 'Default profile'),
      },
    ],
    datedBy: 'visit time',
    permissions: `${turnOnFullDiskAccess} Open Safari to let it fetch history and tabs from your other devices.`,
    note: 'Profiles select history, windows, tab groups, tabs, recently closed tabs and downloads. Dates select history visits, and the pages and topics those visits reach.',
    // Bookmarks, the Reading List and iCloud Tabs belong to no profile or date.
    unscoped: [
      'bookmarks',
      'readingListItems',
      'cloudTabDevices',
      'cloudTabs',
      'cloudTabPositions',
      'cloudTabCloseRequests',
    ],
    source: (scope) => new AppleSafariSource({ scope }),
  },
  books: {
    title: 'Books',
    fullDiskAccess: true,
    // Books' collections are built-in lists; everything is imported.
    choices: [],
    // Collections live in the library store every Books import reads.
    probe: 'collections',
    datedBy: null,
    permissions: `${turnOnFullDiskAccess} Books does not need to be open. Books stored only in iCloud are listed without their files; open them in Books to download them.`,
    source: () => new AppleBooksSource(),
  },
};

const isApp = (app: string): app is App =>
  (appNames as readonly string[]).includes(app);

// What an app can be narrowed by, for the selection rules both hosts share.
export function appFacts(app: string): AppFacts {
  if (!isApp(app)) throw new TypeError(`Unknown Apple app ${app}`);
  const { choices, datedBy } = apps[app];
  return {
    narrowsBy: (kind) => choices.some(({ scope }) => scope === kind),
    datedBy,
  };
}
