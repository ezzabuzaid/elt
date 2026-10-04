import type {
  AccountDocument,
  CalendarDocument,
  EventKitDocument,
  IcsDocument,
  OccurrenceDocument,
} from '@workspace/source-apple-eventkit/eventkit-documents';
import {
  type RelatedRows,
  accountRow,
  calendarRow,
  location,
  relatedRows,
  scopedCollections,
  timestamp,
} from '@workspace/source-apple-eventkit/eventkit-rows';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import { icsRecords, icsStreams, validateIcsExports } from './ics-records.ts';

type Row = Record<string, unknown>;

// Every Calendar stream's rows from one helper read. An occurrence the helper
// returned for several windows keeps its first rows.
export function calendarRows(
  documents: readonly EventKitDocument[],
  scope: ImportScope,
): Map<string, Row[]> {
  const accounts: AccountDocument[] = [];
  const calendars: CalendarDocument[] = [];
  const events = new Map<string, Row>();
  const related: RelatedRows[] = [];
  const exports: IcsDocument[] = [];
  for (const document of documents) {
    if (document.type === 'account') accounts.push(document);
    else if (document.type === 'calendar') calendars.push(document);
    else if (document.type === 'ics') exports.push(document);
    else if (document.type === 'occurrence') {
      const event = eventRow(document);
      if (events.has(event.eventId)) continue;
      events.set(event.eventId, event);
      related.push(relatedRows(document, event.eventId, 'eventId'));
    }
  }
  const collections = scopedCollections(scope, accounts, calendars);
  const items = validateIcsExports(exports);
  return new Map<string, Row[]>([
    ['accounts', collections.accounts.map(accountRow)],
    [
      'calendars',
      collections.calendars.map((calendar) => ({
        ...calendarRow(calendar),
        description: calendar.notes ?? '',
      })),
    ],
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

// An occurrence's id: its item plus, for a recurring event, the occurrence it
// replaces (a local date when all-day), so rescheduling keeps the id.
function eventRow(occurrence: OccurrenceDocument) {
  const recurring =
    occurrence.recurrenceRules.length > 0 || occurrence.detached;
  if (recurring && occurrence.occurrenceMs === undefined)
    throw new TypeError(
      'EventKit returned a recurring event without an occurrence date',
    );
  const occurrenceKey = !recurring
    ? null
    : occurrence.allDay
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
