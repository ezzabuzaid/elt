import type { RecordDraft, SchemaRecord } from '@workspace/elt';

import {
  type CalendarEvent,
  type CalendarScan,
  location,
  timestamp,
} from '../calendar-scan.ts';
import {
  CalendarStream,
  calendarFields,
  locationFields,
} from '../calendar-stream.ts';

const {
  id,
  text,
  nullableText,
  timestamp: timestampField,
  nullableTimestamp,
  nullableDate,
  boolean,
  ordinal,
  integer,
} = calendarFields;

const properties = {
  id: { ...id, description: 'Same value as eventId; the record key.' },
  eventId: {
    ...id,
    description:
      'Occurrence identity: JSON [calendarId, calendarItemId, occurrenceKey]. occurrenceKey is NULL for a nonrecurring event, occurrenceDate for a recurring all-day event and occurrenceAt for a recurring timed event, so moving an occurrence keeps its identity. An event is recurring when it has recurrence rules or is detached. Related EventKit rows join here.',
  },
  calendarId: {
    ...id,
    description:
      'EventKit EKCalendarItem.calendar.calendarIdentifier; refers to calendars.id within this source.',
  },
  calendarItemId: {
    ...id,
    description:
      'EventKit EKCalendarItem.calendarItemIdentifier of the native item; every occurrence of a recurring series shares it. ICS rows relate on (calendarId, calendarItemId). Apple documents that a full sync can replace it.',
  },
  externalId: {
    ...nullableText,
    description:
      'EventKit EKCalendarItem.calendarItemExternalIdentifier, the server-provided identifier shared by every occurrence of a series; NULL when EventKit has none. Apple documents duplicates across calendars (imports, shared or delegated calendars), so it is not unique.',
  },
  nativeEventId: {
    ...nullableText,
    description:
      'EventKit EKEvent.eventIdentifier; NULL when EventKit has none. Apple documents that it can change when the event moves calendar or syncs; it is not the occurrence identity.',
  },
  name: { ...text, description: 'EventKit EKCalendarItem.title.' },
  body: {
    ...nullableText,
    description: 'EventKit EKCalendarItem.notes; NULL when unset.',
  },
  location: {
    ...nullableText,
    description: 'EventKit EKCalendarItem.location; NULL when unset.',
  },
  url: {
    ...nullableText,
    description: 'EventKit EKCalendarItem.URL as a string; NULL when unset.',
  },
  startAt: {
    ...timestampField,
    description:
      'EventKit EKEvent.startDate as a UTC timestamp. Apple returns a floating event, such as an all-day event, in the default time zone of the process that read it; use startDate for all-day days.',
  },
  endAt: {
    ...timestampField,
    description:
      'EventKit EKEvent.endDate as a UTC timestamp; never before startAt. Floating events use the reading process time zone, as startAt does.',
  },
  allDay: { ...boolean, description: 'EventKit EKEvent.isAllDay.' },
  startDate: {
    ...nullableDate,
    description:
      'For an all-day event, the local calendar date of EventKit EKEvent.startDate in the default time zone of the process that read it, as Calendar shows it; NULL for a timed event.',
  },
  endDate: {
    ...nullableDate,
    description:
      'For an all-day event, the local calendar date of EventKit EKEvent.endDate in the default time zone of the process that read it, not adjusted to an inclusive or exclusive end; NULL for a timed event.',
  },
  timeZone: {
    ...nullableText,
    description:
      'EventKit EKCalendarItem.timeZone identifier; NULL for a floating event, which Apple documents as occurring at the same wall-clock time in every time zone.',
  },
  createdAt: {
    ...nullableTimestamp,
    description:
      'EventKit EKCalendarItem.creationDate as a UTC timestamp; NULL when EventKit has none.',
  },
  modifiedAt: {
    ...nullableTimestamp,
    description:
      'EventKit EKCalendarItem.lastModifiedDate as a UTC timestamp; NULL when EventKit has none.',
  },
  occurrenceAt: {
    ...nullableTimestamp,
    description:
      'EventKit EKEvent.occurrenceDate as a UTC timestamp: when this occurrence was originally scheduled, unchanged when it is detached and moved. NULL for a nonrecurring event.',
  },
  occurrenceDate: {
    ...nullableDate,
    description:
      'Local calendar date of EventKit EKEvent.occurrenceDate in the default time zone of the process that read it, set only for a recurring all-day event; NULL otherwise.',
  },
  detached: {
    ...boolean,
    description:
      'EventKit EKEvent.isDetached: an occurrence of a recurring series changed from what the series generates.',
  },
  status: {
    ...ordinal,
    description:
      'EventKit EKEvent.status raw value (EKEventStatus): 0 none, 1 confirmed, 2 tentative, 3 canceled. Apple documents only canceled as reliable. Unknown codes are kept as numbers.',
  },
  availability: {
    ...integer,
    description:
      'EventKit EKEvent.availability raw value (EKEventAvailability): -1 not supported by the calendar, 0 busy, 1 free, 2 tentative, 3 unavailable. Unknown codes are kept as numbers.',
  },
  birthdayContactId: {
    ...nullableText,
    description:
      'EventKit EKEvent.birthdayContactIdentifier, a Contacts framework contact identifier set only for events of the Birthdays calendar; NULL otherwise. Not verified to match identifiers of the Apple Contacts source.',
  },
  ...locationFields('EKEvent.structuredLocation'),
} as const;

export class EventsStream extends CalendarStream<
  typeof properties,
  CalendarEvent
> {
  readonly name = 'events';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per event occurrence, not per series: a recurring event yields one record for each occurrence overlapping the configured UTC interval [startAt, endAt); a zero-duration event must start inside it. Key id equals eventId, JSON [calendarId, calendarItemId, occurrenceKey]; never substitute nativeEventId or startAt for it. attendees, alarms, recurrenceRules and recurrenceRuleValues join on eventId. ICS rows describe the whole native item at (calendarId, calendarItemId) and can cover occurrences outside the interval; only a nonrecurring VEVENT carries eventId. startAt and endAt are UTC instants; startDate and endDate are local calendar dates, set for all-day events only. Only calendars visible on this Mac within the import scope are read. Relationships name source streams, not destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  // The schema cannot relate one field to another, so the dates are checked
  // against each other once each record is valid.
  override async read(
    scan: CalendarScan,
  ): Promise<SchemaRecord<typeof properties>[]> {
    const events = await super.read(scan);
    for (const event of events) {
      const endsBeforeStart = event.endAt < event.startAt;
      const datesInconsistent = event.allDay
        ? event.startDate === null ||
          event.endDate === null ||
          event.endDate < event.startDate
        : event.startDate !== null || event.endDate !== null;
      if (endsBeforeStart || datesInconsistent)
        throw new TypeError('Calendar returned inconsistent event dates');
    }
    return events;
  }

  protected rows(scan: CalendarScan): readonly CalendarEvent[] {
    return scan.events;
  }

  protected record({
    eventId,
    recurring,
    occurrence,
  }: CalendarEvent): RecordDraft<typeof properties> {
    const { allDay } = occurrence;
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
      ...location(occurrence.place),
    };
  }
}
