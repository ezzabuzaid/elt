import type {
  AccountDocument,
  AlarmDocument,
  CalendarContents,
  CalendarDocument,
  LocationDocument,
  OccurrenceDocument,
  ParticipantDocument,
} from '@workspace/macos-eventkit';

import { icsRecords, icsStreams, validateIcsExports } from './ics-records.ts';

type Row = Record<string, unknown>;
type RelatedRows = ReturnType<typeof relatedRows>;

// Every Calendar stream's rows from one store read. An occurrence the store
// listed for several read windows keeps its first rows.
export function calendarRows(contents: CalendarContents): Map<string, Row[]> {
  const events = new Map<string, Row>();
  const related: RelatedRows[] = [];
  for (const occurrence of contents.occurrences) {
    const event = eventRow(occurrence);
    if (events.has(event.eventId)) continue;
    events.set(event.eventId, event);
    related.push(relatedRows(occurrence, event.eventId));
  }
  const items = validateIcsExports(contents.icsExports);
  return new Map<string, Row[]>([
    ['accounts', contents.accounts.map(accountRow)],
    ['calendars', contents.calendars.map(calendarRow)],
    ['events', [...events.values()]],
    ['attendees', related.flatMap((rows) => rows.attendees)],
    ['alarms', related.flatMap((rows) => rows.alarms)],
    ['recurrenceRules', related.flatMap((rows) => rows.recurrenceRules)],
    [
      'recurrenceRuleValues',
      related.flatMap((rows) => rows.recurrenceRuleValues),
    ],
    ...icsStreams.map((stream): [string, Row[]] => [
      stream,
      items.flatMap((item) => icsRecords(stream, item)),
    ]),
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

function calendarRow(calendar: CalendarDocument): Row {
  return {
    id: calendar.id,
    accountId: calendar.accountId ?? null,
    name: calendar.name,
    type: calendar.calendarType,
    writable: calendar.writable,
    subscribed: calendar.subscribed,
    immutable: calendar.immutable,
    colorRed: calendar.color?.[0] ?? null,
    colorGreen: calendar.color?.[1] ?? null,
    colorBlue: calendar.color?.[2] ?? null,
    colorAlpha: calendar.color?.[3] ?? null,
    supportedAvailabilities: calendar.supportedAvailabilities,
    allowedEntityTypes: calendar.allowedEntityTypes,
    description: calendar.notes ?? '',
  };
}

// An occurrence's id: its item plus, for a recurring event, the occurrence it
// replaces (a local date when all-day), so rescheduling keeps the id.
function eventRow(occurrence: OccurrenceDocument) {
  const recurring =
    occurrence.recurrenceRules.length > 0 || occurrence.detached;
  if (recurring && occurrence.occurrenceMs === undefined)
    throw new TypeError(
      'EventKit returned a recurring event without an occurrence date',
    );
  let occurrenceKey: string | null = null;
  if (recurring)
    occurrenceKey = occurrence.allDay
      ? (occurrence.occurrenceDay ?? null)
      : timestamp(occurrence.occurrenceMs);
  const eventId = JSON.stringify([
    occurrence.calendarId,
    occurrence.calendarItemId,
    occurrenceKey,
  ]);
  const { allDay } = occurrence;
  const place = location(occurrence.place);
  return {
    id: eventId,
    eventId,
    calendarId: occurrence.calendarId,
    calendarItemId: occurrence.calendarItemId,
    externalId: occurrence.externalId ?? null,
    nativeEventId: occurrence.nativeEventId ?? null,
    name: occurrence.name ?? null,
    body: occurrence.body ?? null,
    location: occurrence.location ?? null,
    url: occurrence.url ?? null,
    startAt: timestamp(occurrence.startMs),
    endAt: timestamp(occurrence.endMs),
    allDay,
    startDate: allDay ? occurrence.startDay : null,
    endDate: allDay ? occurrence.endDay : null,
    timeZone: occurrence.timeZone ?? null,
    createdAt: timestamp(occurrence.createdMs),
    modifiedAt: timestamp(occurrence.modifiedMs),
    occurrenceAt: recurring ? timestamp(occurrence.occurrenceMs) : null,
    occurrenceDate:
      allDay && recurring ? (occurrence.occurrenceDay ?? null) : null,
    detached: occurrence.detached,
    status: occurrence.status,
    availability: occurrence.availability,
    birthdayContactId: occurrence.birthdayContactId ?? null,
    ...place,
  };
}

function participantRow(
  eventId: string,
  participant: ParticipantDocument,
  kind: 'organizer' | 'attendee',
  position: number,
): Row {
  return {
    id: JSON.stringify([eventId, kind, position]),
    eventId,
    position,
    kind,
    name: participant.name ?? null,
    url: participant.url,
    status: participant.status,
    role: participant.role,
    type: participant.participantType,
    isCurrentUser: participant.isCurrentUser,
  };
}

function alarmRow(eventId: string, alarm: AlarmDocument, position: number) {
  return {
    id: JSON.stringify([eventId, position]),
    eventId,
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

// The organizer, attendees, alarms and recurrence rows of one occurrence. The
// store lists attendees and alarms in a stable order, so positions are stable.
function relatedRows(occurrence: OccurrenceDocument, eventId: string) {
  const attendees: Row[] = [];
  if (occurrence.organizer !== undefined)
    attendees.push(
      participantRow(eventId, occurrence.organizer, 'organizer', 0),
    );
  for (const [position, attendee] of occurrence.attendees.entries())
    attendees.push(participantRow(eventId, attendee, 'attendee', position));

  const alarms = occurrence.alarms.map((alarm, position) =>
    alarmRow(eventId, alarm, position),
  );

  const recurrenceRules: Row[] = [];
  const recurrenceRuleValues: Row[] = [];
  for (const [position, rule] of occurrence.recurrenceRules.entries()) {
    const ruleId = JSON.stringify([eventId, 'recurrenceRule', position]);
    recurrenceRules.push({
      id: ruleId,
      eventId,
      position,
      calendarIdentifier: rule.calendarIdentifier ?? null,
      frequency: rule.frequency,
      interval: rule.interval,
      firstDayOfWeek: rule.firstDayOfWeek,
      endAt: timestamp(rule.end?.endMs),
      occurrenceCount: rule.end?.occurrenceCount ?? 0,
    });
    const valueRow = (
      component: string,
      position: number,
      value: number,
      weekNumber: number | null,
    ) => ({
      id: JSON.stringify([ruleId, component, position]),
      eventId,
      ruleId,
      component,
      position,
      value,
      weekNumber,
    });
    for (const [position, day] of rule.daysOfTheWeek.entries())
      recurrenceRuleValues.push(
        valueRow('daysOfTheWeek', position, day.day, day.weekNumber),
      );
    for (const component of [
      'daysOfTheMonth',
      'daysOfTheYear',
      'weeksOfTheYear',
      'monthsOfTheYear',
      'setPositions',
    ] as const)
      for (const [position, value] of rule[component].entries())
        recurrenceRuleValues.push(valueRow(component, position, value, null));
  }
  return { attendees, alarms, recurrenceRules, recurrenceRuleValues };
}
