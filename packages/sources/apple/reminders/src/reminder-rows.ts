import type {
  AccountDocument,
  AlarmDocument,
  CalendarDocument,
  DateComponentsDocument,
  LocationDocument,
  ParticipantDocument,
  ReminderDocument,
  RemindersContents,
} from '@workspace/macos-eventkit';

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

// Every Reminders stream's rows from one store read.
export function reminderRows(contents: RemindersContents): Map<string, Row[]> {
  const related = contents.reminders.map(relatedRows);
  return new Map<string, Row[]>([
    ['accounts', contents.accounts.map(accountRow)],
    ['lists', contents.calendars.map(listRow)],
    ['reminders', contents.reminders.map(reminderRow)],
    [
      'dateComponents',
      contents.reminders.flatMap((reminder) =>
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

function timestamp(ms: number | undefined): string | null {
  return ms === undefined ? null : new Date(ms).toISOString();
}

function location(place: LocationDocument | undefined) {
  return {
    locationTitle: place?.title ?? null,
    latitude: place?.latitude ?? null,
    longitude: place?.longitude ?? null,
    radius: place?.radius ?? null,
  };
}

function accountRow(account: AccountDocument): Row {
  return {
    id: account.id,
    name: account.name,
    type: account.sourceType,
    isDelegate: account.isDelegate,
  };
}

function listRow(list: CalendarDocument): Row {
  return {
    id: list.id,
    accountId: list.accountId ?? null,
    name: list.name,
    type: list.calendarType,
    writable: list.writable,
    subscribed: list.subscribed,
    immutable: list.immutable,
    colorRed: list.color?.[0] ?? null,
    colorGreen: list.color?.[1] ?? null,
    colorBlue: list.color?.[2] ?? null,
    colorAlpha: list.color?.[3] ?? null,
    supportedAvailabilities: list.supportedAvailabilities,
    allowedEntityTypes: list.allowedEntityTypes,
  };
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

function attendeeRow(
  reminderId: string,
  attendee: ParticipantDocument,
  position: number,
): Row {
  return {
    id: JSON.stringify([reminderId, 'attendee', position]),
    reminderId,
    position,
    kind: 'attendee',
    name: attendee.name ?? null,
    url: attendee.url,
    status: attendee.status,
    role: attendee.role,
    type: attendee.participantType,
    isCurrentUser: attendee.isCurrentUser,
  };
}

function alarmRow(reminderId: string, alarm: AlarmDocument, position: number) {
  return {
    id: JSON.stringify([reminderId, position]),
    reminderId,
    position,
    type: alarm.alarmType,
    relativeOffset: alarm.relativeOffset,
    absoluteAt: timestamp(alarm.absoluteMs),
    emailAddress: alarm.emailAddress ?? null,
    soundName: alarm.soundName ?? null,
    proximity: alarm.proximity,
    ...location(alarm.location),
  };
}

// The attendees, alarms and recurrence rows of one reminder. The store lists
// attendees and alarms in a stable order, so positions are stable.
function relatedRows(reminder: ReminderDocument) {
  const reminderId = reminder.id;
  const attendees = reminder.attendees.map((attendee, position) =>
    attendeeRow(reminderId, attendee, position),
  );
  const alarms = reminder.alarms.map((alarm, position) =>
    alarmRow(reminderId, alarm, position),
  );

  const recurrenceRules: Row[] = [];
  const recurrenceRuleValues: Row[] = [];
  for (const [position, rule] of reminder.recurrenceRules.entries()) {
    const ruleId = JSON.stringify([reminderId, 'recurrenceRule', position]);
    recurrenceRules.push({
      id: ruleId,
      reminderId,
      position,
      calendarIdentifier: rule.calendarIdentifier ?? null,
      frequency: rule.frequency,
      interval: rule.interval,
      firstDayOfWeek: rule.firstDayOfWeek,
      endAt: timestamp(rule.end?.endMs),
      occurrenceCount: rule.end?.occurrenceCount ?? 0,
    });
    const value = (
      component: string,
      index: number,
      value: number,
      weekNumber: number | null,
    ) => ({
      id: JSON.stringify([ruleId, component, index]),
      reminderId,
      ruleId,
      component,
      position: index,
      value,
      weekNumber,
    });
    for (const [index, day] of rule.daysOfTheWeek.entries())
      recurrenceRuleValues.push(
        value('daysOfTheWeek', index, day.day, day.weekNumber),
      );
    for (const component of [
      'daysOfTheMonth',
      'daysOfTheYear',
      'weeksOfTheYear',
      'monthsOfTheYear',
      'setPositions',
    ] as const)
      for (const [index, number] of rule[component].entries())
        recurrenceRuleValues.push(value(component, index, number, null));
  }
  return { attendees, alarms, recurrenceRules, recurrenceRuleValues };
}
