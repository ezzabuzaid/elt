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
import type { ImportScope } from '../sources/import-scope.ts';

export const appNames = [
  'mail',
  'notes',
  'messages',
  'contacts',
  'calendar',
  'reminders',
] as const;
export type App = (typeof appNames)[number];

type AppDefinition = {
  // Streams that list the accounts and collections a user chooses from.
  readonly choices: readonly string[];
  readonly accounts: boolean;
  readonly dateField: string | null;
  readonly permissions: string;
  readonly note?: string;
  // Streams whose rows cannot be attributed to a chosen account or collection.
  readonly unscoped?: readonly string[];
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

export const apps: Record<App, AppDefinition> = {
  mail: {
    choices: ['accounts', 'mailboxes'],
    accounts: true,
    dateField: 'dateReceived (dateSent if absent)',
    permissions:
      'Allow Codex in System Settings > Privacy & Security > Full Disk Access, and allow it to control Mail when macOS asks.',
    unscoped: restrictedMailStreams,
    source: (scope) => new AppleMailSource(mailDirectory, scope),
  },
  notes: {
    choices: ['accounts', 'folders'],
    accounts: true,
    dateField: 'modifiedAt',
    permissions:
      'Allow Codex in System Settings > Privacy & Security > Full Disk Access. Open Notes to let it finish syncing iCloud changes.',
    note: 'Exact containing folders; select descendants separately. Smart folders are saved searches and cannot be selected as containing folders.',
    source: (scope) => new AppleNotesSource({ scope }),
  },
  messages: {
    choices: ['chats'],
    accounts: false,
    dateField: 'date',
    permissions:
      'Allow Codex in System Settings > Privacy & Security > Full Disk Access. Only messages synced to this Mac can be imported.',
    source: (scope) => new AppleMessagesSource(undefined, undefined, scope),
  },
  contacts: {
    choices: ['containers'],
    accounts: false,
    dateField: null,
    permissions:
      'Allow Codex in System Settings > Privacy & Security > Contacts or Full Disk Access.',
    source: (scope) => new AppleContactsSource(undefined, undefined, scope),
  },
  calendar: {
    choices: ['accounts', 'calendars'],
    accounts: true,
    dateField: 'event occurrence overlap',
    permissions:
      'Allow full Calendar access when macOS asks, and allow Codex to control Calendar for calendar descriptions. Access can be changed under System Settings > Privacy & Security > Calendars and Automation.',
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
    choices: ['accounts', 'lists'],
    accounts: true,
    dateField: null,
    permissions:
      'Allow Reminders access when macOS asks. Access can be changed under System Settings > Privacy & Security > Reminders.',
    source: (scope) => new AppleRemindersSource(scope),
  },
};
