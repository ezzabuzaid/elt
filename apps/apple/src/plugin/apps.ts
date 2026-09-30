import type { Source } from 'elt';
import { mailDirectory } from '../platform/macos/mail-store.ts';
import { AppleCalendarSource } from '../sources/apple-calendar/apple-calendar-source.ts';
import { AppleContactsSource } from '../sources/apple-contacts/apple-contacts-source.ts';
import {
  AppleMailSource,
  restrictedMailStreams,
} from '../sources/apple-mail/apple-mail-source.ts';
import { AppleMessagesSource } from '../sources/apple-messages/apple-messages-source.ts';
import { AppleNotesSource } from '../sources/apple-notes/apple-notes-source.ts';
import { AppleRemindersSource } from '../sources/apple-reminders/apple-reminders-source.ts';
import { AppleSafariSource } from '../sources/apple-safari/apple-safari-source.ts';
import type { ImportScope } from '../sources/import-scope.ts';

export const appNames = [
  'mail',
  'notes',
  'messages',
  'contacts',
  'calendar',
  'reminders',
  'safari',
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
  readonly accounts: boolean;
  // How dates select records, in the user's words; null when they cannot.
  readonly datedBy: string | null;
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

export function calendarDefaults(now = new Date()) {
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  const end = new Date(now);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
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
const fullDiskAccess =
  'Turn on ChatGPT in System Settings > Privacy & Security > Full Disk Access, then quit and reopen ChatGPT. macOS does not ask for this access.';

export const apps: Record<App, AppDefinition> = {
  mail: {
    title: 'Mail',
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
    accounts: true,
    datedBy: 'date received (date sent if missing)',
    permissions: `${fullDiskAccess} Allow ChatGPT to control Mail when macOS asks.`,
    unscoped: restrictedMailStreams,
    // Each message's raw .emlx; messageParts already holds its decoded text.
    storeCopies: ['messageFiles'],
    source: (scope) => new AppleMailSource(mailDirectory, scope),
  },
  notes: {
    title: 'Notes',
    choices: [accounts, collections('folders')],
    accounts: true,
    datedBy: 'date last edited',
    permissions: `${fullDiskAccess} Open Notes to let it finish syncing iCloud changes.`,
    note: 'Exact containing folders; select descendants separately. Smart folders are saved searches and cannot be selected as containing folders.',
    source: (scope) => new AppleNotesSource({ scope }),
  },
  messages: {
    title: 'Messages',
    choices: [
      {
        stream: 'chats',
        scope: 'collectionIds',
        id: (row) => String(row.guid),
        label: (row) => String(row.displayName || row.chatIdentifier),
      },
    ],
    accounts: false,
    datedBy: 'message date',
    permissions: `${fullDiskAccess} Only messages synced to this Mac can be imported.`,
    source: (scope) => new AppleMessagesSource(undefined, undefined, scope),
  },
  contacts: {
    title: 'Contacts',
    choices: [{ ...accounts, stream: 'containers', scope: 'collectionIds' }],
    accounts: false,
    datedBy: null,
    permissions:
      'Allow ChatGPT when macOS asks for Contacts access, or turn it on in System Settings > Privacy & Security > Contacts. Full Disk Access for ChatGPT also works.',
    source: (scope) => new AppleContactsSource(undefined, undefined, scope),
  },
  calendar: {
    title: 'Calendar',
    choices: [accounts, collections('calendars')],
    accounts: true,
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
    choices: [accounts, collections('lists')],
    accounts: true,
    datedBy: null,
    permissions:
      'Allow full Reminders access when macOS asks. Access can be changed under System Settings > Privacy & Security > Reminders.',
    source: (scope) => new AppleRemindersSource(scope),
  },
  safari: {
    title: 'Safari',
    choices: [
      {
        stream: 'profiles',
        scope: 'collectionIds',
        id: byId,
        // Safari stores no name for the profile it starts with.
        label: (row) => String(row.title ?? 'Default profile'),
      },
    ],
    accounts: false,
    datedBy: 'visit time',
    permissions: `${fullDiskAccess} Open Safari to let it fetch history and tabs from your other devices.`,
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
};
