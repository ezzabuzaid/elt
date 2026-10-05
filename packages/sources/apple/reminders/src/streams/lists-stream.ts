import type { RecordDraft } from '@workspace/elt';
import type { CalendarDocument } from '@workspace/sdk-apple-eventkit';

import {
  AppleRemindersStream,
  remindersFields,
} from '../apple-reminders-stream.ts';
import type { RemindersScan } from '../reminders-scan.ts';

const { id, text, ordinal, boolean } = remindersFields;
const color = { type: ['number', 'null'], minimum: 0, maximum: 1 } as const;

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
} as const;

export class ListsStream extends AppleRemindersStream<
  typeof properties,
  CalendarDocument
> {
  readonly name = 'lists';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per reminder list (an EventKit calendar for reminders) visible on this Mac. An import scope keeps only the selected lists. accountId refers to accounts.id; reminders.listId refers to id. Relationships name source streams, not destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: RemindersScan): readonly CalendarDocument[] {
    return scan.lists;
  }

  protected record(list: CalendarDocument): RecordDraft<typeof properties> {
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
}
