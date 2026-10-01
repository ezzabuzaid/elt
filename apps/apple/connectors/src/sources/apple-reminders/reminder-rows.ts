import type {
  AccountDocument,
  CalendarDocument,
  DateComponentsDocument,
  EventKitDocument,
  ReminderDocument,
} from '../../platform/macos/eventkit-documents.ts';
import {
  accountRow,
  calendarRow,
  relatedRows,
  scopedCollections,
  timestamp,
} from '../eventkit-rows.ts';
import type { ImportScope } from '../import-scope.ts';

type Row = Record<string, unknown>;

export const dateComponentNames = [
  'era',
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
  'nanosecond',
  'weekday',
  'weekdayOrdinal',
  'quarter',
  'weekOfMonth',
  'weekOfYear',
  'yearForWeekOfYear',
  'dayOfYear',
] as const;

// Every Reminders stream's rows from one helper read.
export function reminderRows(
  documents: readonly EventKitDocument[],
  scope: ImportScope,
): Map<string, Row[]> {
  const accounts: AccountDocument[] = [];
  const lists: CalendarDocument[] = [];
  const reminders: ReminderDocument[] = [];
  for (const document of documents) {
    if (document.type === 'account') accounts.push(document);
    else if (document.type === 'calendar') lists.push(document);
    else if (document.type === 'reminder') reminders.push(document);
  }
  const collections = scopedCollections(scope, accounts, lists);
  const related = reminders.map((reminder) =>
    relatedRows(reminder, reminder.id, 'reminderId'),
  );
  return new Map<string, Row[]>([
    ['accounts', collections.accounts.map(accountRow)],
    ['lists', collections.calendars.map(calendarRow)],
    ['reminders', reminders.map(reminderRow)],
    [
      'dateComponents',
      reminders.flatMap((reminder) =>
        (['start', 'due'] as const).flatMap((kind) => {
          const components = reminder[kind];
          return components === undefined
            ? []
            : [dateComponentsRow(reminder.id, kind, components)];
        }),
      ),
    ],
    ['attendees', related.flatMap((rows) => rows.attendees)],
    ['alarms', related.flatMap((rows) => rows.alarms)],
    ['recurrenceRules', related.flatMap((rows) => rows.recurrenceRules)],
    [
      'recurrenceRuleValues',
      related.flatMap((rows) => rows.recurrenceRuleValues),
    ],
  ]);
}

function reminderRow(reminder: ReminderDocument): Row {
  return {
    id: reminder.id,
    listId: reminder.listId,
    externalId: reminder.externalId ?? null,
    name: reminder.name ?? null,
    body: reminder.body ?? null,
    location: reminder.location ?? null,
    url: reminder.url ?? null,
    timeZone: reminder.timeZone ?? null,
    createdAt: timestamp(reminder.createdMs),
    modifiedAt: timestamp(reminder.modifiedMs),
    completed: reminder.completed,
    completedAt: timestamp(reminder.completedMs),
    priority: reminder.priority,
  };
}

// One start or due component set, kept whole: a missing component stays null
// instead of becoming a manufactured date.
function dateComponentsRow(
  reminderId: string,
  kind: 'start' | 'due',
  components: DateComponentsDocument,
): Row {
  return {
    id: JSON.stringify([reminderId, kind]),
    reminderId,
    kind,
    calendarIdentifier: components.calendarIdentifier ?? null,
    timeZone: components.timeZone ?? null,
    ...Object.fromEntries(
      dateComponentNames.map((name) => [name, components[name] ?? null]),
    ),
    leapMonth: components.leapMonth,
    repeatedDay: components.repeatedDay,
  };
}
