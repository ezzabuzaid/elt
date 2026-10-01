import type {
  AccountDocument,
  AlarmDocument,
  CalendarDocument,
  CalendarItemDocument,
  LocationDocument,
  ParticipantDocument,
} from '../platform/macos/eventkit-documents.ts';
import type { ImportScope } from './import-scope.ts';

type Row = Record<string, unknown>;

export function timestamp(ms: number | undefined): string | null {
  return ms === undefined ? null : new Date(ms).toISOString();
}

export function location(place: LocationDocument | undefined) {
  return {
    locationTitle: place?.title ?? null,
    latitude: place?.latitude ?? null,
    longitude: place?.longitude ?? null,
    radius: place?.radius ?? null,
  };
}

// A scoped read keeps the calendars the helper selected, and the accounts
// that own one of them.
export function scopedCollections(
  scope: ImportScope,
  accounts: readonly AccountDocument[],
  calendars: readonly CalendarDocument[],
) {
  if (scope.accountIds === undefined && scope.collectionIds === undefined)
    return { accounts, calendars };
  const selected = calendars.filter((calendar) => calendar.selected);
  return {
    accounts: accounts.filter(
      (account) =>
        (scope.accountIds?.includes(account.id) ?? true) &&
        (scope.collectionIds === undefined ||
          selected.some((calendar) => calendar.accountId === account.id)),
    ),
    calendars: selected,
  };
}

export function accountRow(account: AccountDocument): Row {
  return {
    id: account.id,
    name: account.name,
    type: account.sourceType,
    isDelegate: account.isDelegate,
  };
}

export function calendarRow(calendar: CalendarDocument): Row {
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
  };
}

// EventKit returns an item's attendees and alarms in a different order in
// each process (verified live), so positions follow their content instead.
function inContentOrder<T>(values: readonly T[], key: (value: T) => unknown) {
  return values
    .map((value) => [JSON.stringify(key(value)), value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, value]) => value);
}

function participantRow(
  itemId: string,
  ownerKey: string,
  participant: ParticipantDocument,
  kind: 'organizer' | 'attendee',
  position: number,
): Row {
  return {
    id: JSON.stringify([itemId, kind, position]),
    [ownerKey]: itemId,
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

function alarmValues(alarm: AlarmDocument) {
  return {
    type: alarm.alarmType,
    relativeOffset: alarm.relativeOffset,
    absoluteAt: timestamp(alarm.absoluteMs),
    emailAddress: alarm.emailAddress ?? null,
    soundName: alarm.soundName ?? null,
    proximity: alarm.proximity,
    ...location(alarm.location),
  };
}

export type RelatedRows = ReturnType<typeof relatedRows>;

// The attendees, alarms and recurrence rows of one calendar item.
export function relatedRows(
  item: CalendarItemDocument & { readonly organizer?: ParticipantDocument },
  itemId: string,
  ownerKey: 'eventId' | 'reminderId',
) {
  const attendees: Row[] = [];
  if (item.organizer !== undefined)
    attendees.push(
      participantRow(itemId, ownerKey, item.organizer, 'organizer', 0),
    );
  // A reply changes status, so status does not order attendees.
  const ordered = inContentOrder(item.attendees, (attendee) => [
    attendee.url,
    attendee.name ?? null,
    attendee.role,
    attendee.participantType,
  ]);
  for (const [position, attendee] of ordered.entries())
    attendees.push(
      participantRow(itemId, ownerKey, attendee, 'attendee', position),
    );

  const alarms = inContentOrder(item.alarms.map(alarmValues), (alarm) =>
    Object.values(alarm),
  ).map((alarm, position) => ({
    id: JSON.stringify([itemId, position]),
    [ownerKey]: itemId,
    position,
    ...alarm,
  }));

  const recurrenceRules: Row[] = [];
  const recurrenceRuleValues: Row[] = [];
  for (const [position, rule] of item.recurrenceRules.entries()) {
    const ruleId = JSON.stringify([itemId, 'recurrenceRule', position]);
    recurrenceRules.push({
      id: ruleId,
      [ownerKey]: itemId,
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
      [ownerKey]: itemId,
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
