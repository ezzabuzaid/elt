import type { RecordDraft } from '@workspace/elt';
import type { CalendarDocument } from '@workspace/sdk-apple-eventkit';

import type { CalendarScan } from '../calendar-scan.ts';
import { CalendarStream, calendarFields } from '../calendar-stream.ts';

const { id, text, ordinal, boolean, color } = calendarFields;

const properties = {
  id: {
    ...id,
    description:
      'EventKit EKCalendar.calendarIdentifier. Apple documents that a full sync can replace it, so it is not a stable identity.',
  },
  accountId: {
    ...id,
    description:
      'EventKit EKCalendar.source.sourceIdentifier: the owning account; refers to accounts.id within this source.',
  },
  name: { ...text, description: 'EventKit EKCalendar.title.' },
  type: {
    ...ordinal,
    description:
      'EventKit EKCalendar.type raw value (EKCalendarType): 0 local, 1 CalDAV, 2 Exchange, 3 subscription, 4 birthday. Apple reports a subscribed CalDAV calendar as 1 with subscribed true. Unknown codes are kept as numbers.',
  },
  writable: {
    ...boolean,
    description:
      'EventKit EKCalendar.allowsContentModifications: whether items can be added, removed or modified in it.',
  },
  subscribed: { ...boolean, description: 'EventKit EKCalendar.isSubscribed.' },
  immutable: {
    ...boolean,
    description:
      'EventKit EKCalendar.isImmutable: the calendar itself cannot be modified or deleted. It does not prevent adding items.',
  },
  colorRed: {
    ...color,
    description:
      'Red component (0 to 1) of EventKit EKCalendar.color converted to sRGB; NULL when the calendar has no color.',
  },
  colorGreen: {
    ...color,
    description:
      'Green component (0 to 1) of EventKit EKCalendar.color converted to sRGB; NULL when the calendar has no color.',
  },
  colorBlue: {
    ...color,
    description:
      'Blue component (0 to 1) of EventKit EKCalendar.color converted to sRGB; NULL when the calendar has no color.',
  },
  colorAlpha: {
    ...color,
    description:
      'Alpha component (0 to 1) of EventKit EKCalendar.color converted to sRGB; NULL when the calendar has no color.',
  },
  supportedAvailabilities: {
    ...ordinal,
    description:
      'EventKit EKCalendar.supportedEventAvailabilities bitmask (EKCalendarEventAvailabilityMask): 1 busy, 2 free, 4 tentative, 8 unavailable; 0 when the calendar does not support event availability.',
  },
  allowedEntityTypes: {
    ...ordinal,
    description:
      'EventKit EKCalendar.allowedEntityTypes bitmask (EKEntityMask): 1 events, 2 reminders.',
  },
  description: {
    ...text,
    description:
      "Calendar.app's calendar description, read from EKCalendar's private notes property; empty when the calendar has none.",
  },
} as const;

export class CalendarsStream extends CalendarStream<
  typeof properties,
  CalendarDocument
> {
  readonly name = 'calendars';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per event calendar visible through EventKit on this Mac. No date filter: the event window does not restrict it. An import scope keeps only the selected calendars. accountId refers to accounts.id; events and ICS rows refer to id through calendarId. Relationships name source streams, not destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;
  override readonly dated = false;

  protected rows(scan: CalendarScan): readonly CalendarDocument[] {
    return scan.calendars;
  }

  protected record(calendar: CalendarDocument): RecordDraft<typeof properties> {
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
}
