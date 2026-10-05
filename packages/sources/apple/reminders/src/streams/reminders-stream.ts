import type { RecordDraft } from '@workspace/elt';
import type { ReminderDocument } from '@workspace/sdk-apple-eventkit';

import {
  AppleRemindersStream,
  remindersFields,
} from '../apple-reminders-stream.ts';
import { type RemindersScan, timestamp } from '../reminders-scan.ts';

const { id, text, nullableText, nullableTimestamp, integer, boolean } =
  remindersFields;

const properties = {
  id: {
    ...id,
    description:
      'EventKit EKCalendarItem.calendarItemIdentifier; related streams refer to it through reminderId. Apple documents that a full sync can replace it.',
  },
  listId: {
    ...id,
    description:
      'EventKit EKCalendarItem.calendar.calendarIdentifier: the owning list; refers to lists.id within this source.',
  },
  externalId: {
    ...nullableText,
    description:
      'EventKit EKCalendarItem.calendarItemExternalIdentifier, the server-provided identifier; NULL when EventKit has none. Apple documents duplicates across calendars and, for Exchange reminders, different values between devices, so it is not unique.',
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
  timeZone: {
    ...nullableText,
    description:
      'EventKit EKCalendarItem.timeZone identifier; NULL when EventKit has none, which Apple documents as floating. The start and due component sets carry their own time zones in dateComponents.',
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
  completed: {
    ...boolean,
    description: 'EventKit EKReminder.isCompleted.',
  },
  completedAt: {
    ...nullableTimestamp,
    description:
      'EventKit EKReminder.completionDate as a UTC timestamp; NULL when EventKit has none.',
  },
  priority: {
    ...integer,
    minimum: 0,
    maximum: 9,
    description:
      'EventKit EKReminder.priority: 0 no priority, 1 highest through 9 lowest. Apple follows RFC 5545 (1 to 4 high, 5 medium, 6 to 9 low); its EKReminderPriority constants are 1 high, 5 medium and 9 low.',
  },
} as const;

export class RemindersStream extends AppleRemindersStream<
  typeof properties,
  ReminderDocument
> {
  readonly name = 'reminders';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per reminder visible through EventKit on this Mac, completed reminders included, limited to the selected lists when an import scope is set. No date filter. Start and due dates live in dateComponents as native component sets; no UTC due timestamp is derived. dateComponents, attendees, alarms, recurrenceRules and recurrenceRuleValues refer to id through reminderId; listId refers to lists.id. Relationships name source streams, not destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: RemindersScan): readonly ReminderDocument[] {
    return scan.reminders;
  }

  protected record(reminder: ReminderDocument): RecordDraft<typeof properties> {
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
}
