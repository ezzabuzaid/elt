import { Catalog, type FieldSchema, Stream } from '@workspace/elt';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import {
  accountFields,
  alarmFields,
  attendeeFields,
  listFields,
  recurrenceRuleFields,
  recurrenceRuleValueFields,
} from './reminder-fields.ts';
import { dateComponentNames } from './reminder-rows.ts';

const { id, text, nullableText, nullableTimestamp, integer, boolean } =
  eventKitFields;

// Each stream's reader-facing meaning and its fields.
const streams: Record<
  string,
  {
    readonly description: string;
    readonly properties: Record<string, FieldSchema>;
  }
> = {
  accounts: {
    description:
      "One source record per EventKit account (EKSource) in this Mac's store, including accounts without reminder lists. An import scope keeps the selected accounts; a list scope also drops accounts owning no selected list. Relationships name source streams, not destination tables.",
    properties: accountFields,
  },
  lists: {
    description:
      'One source record per reminder list (an EventKit calendar for reminders) visible on this Mac. An import scope keeps only the selected lists. accountId refers to accounts.id; reminders.listId refers to id. Relationships name source streams, not destination tables.',
    properties: listFields,
  },
  reminders: {
    description:
      'One source record per reminder visible through EventKit on this Mac, completed reminders included, limited to the selected lists when an import scope is set. No date filter. Start and due dates live in dateComponents as native component sets; no UTC due timestamp is derived. dateComponents, attendees, alarms, recurrenceRules and recurrenceRuleValues refer to id through reminderId; listId refers to lists.id. Relationships name source streams, not destination tables.',
    properties: {
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
        description:
          'EventKit EKCalendarItem.URL as a string; NULL when unset.',
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
    },
  },
  dateComponents: {
    description:
      "One source record per start or due date a reminder sets; a reminder without that date has no record. Each record keeps EventKit's NSDateComponents set whole: calendar, time zone, leap month and every component, with a missing component NULL and no manufactured UTC timestamp. A date without a time has NULL hour, minute and second. reminderId refers to reminders.id. Relationships name source streams, not destination tables.",
    properties: {
      id: {
        ...id,
        description: 'JSON [reminderId, kind]; unique within this stream.',
      },
      reminderId: {
        ...id,
        description:
          'Owning reminder; refers to reminders.id within this source.',
      },
      kind: {
        ...text,
        enum: ['start', 'due'],
        description:
          'start for EventKit EKReminder.startDateComponents, due for EKReminder.dueDateComponents.',
      },
      calendarIdentifier: {
        ...nullableText,
        description:
          'Identifier of the NSDateComponents calendar, the calendar system the components count in; NULL when the set has no calendar.',
      },
      timeZone: {
        ...nullableText,
        description:
          'NSDateComponents.timeZone identifier; NULL for a floating date, which Apple documents as a nil time zone.',
      },
      ...Object.fromEntries(
        dateComponentNames.map((name) => [
          name,
          {
            type: ['integer', 'null'],
            description: `NSDateComponents.${name}; NULL when the set leaves it undefined or this macOS does not provide it.`,
          },
        ]),
      ),
      leapMonth: {
        ...boolean,
        description:
          "NSDateComponents.isLeapMonth: whether month is a leap month in the set's calendar.",
      },
      repeatedDay: {
        ...boolean,
        description:
          "NSDateComponents.isRepeatedDay: whether day is a repeated day in the set's calendar.",
      },
    },
  },
  attendees: {
    description:
      'One source record per attendee EventKit lists for a reminder. reminderId refers to reminders.id. Relationships name source streams, not destination tables.',
    properties: attendeeFields,
  },
  alarms: {
    description:
      'One source record per EventKit alarm of a reminder, whether it fires at a time or at a location. reminderId refers to reminders.id. Relationships name source streams, not destination tables.',
    properties: alarmFields,
  },
  recurrenceRules: {
    description:
      "One source record per EventKit recurrence rule of a reminder. reminderId refers to reminders.id; recurrenceRuleValues holds each rule's list values. Relationships name source streams, not destination tables.",
    properties: recurrenceRuleFields,
  },
  recurrenceRuleValues: {
    description:
      "One source record per entry of a recurrence rule's day, week, month or set-position lists. ruleId refers to recurrenceRules.id and reminderId to reminders.id. Relationships name source streams, not destination tables.",
    properties: recurrenceRuleValueFields,
  },
};

export const catalog = new Catalog(
  Object.entries(streams).map(
    ([name, { description, properties }]) =>
      new Stream({
        name,
        jsonSchema: {
          type: 'object',
          description,
          properties,
          required: Object.keys(properties),
        },
        primaryKey: ['id'],
        // Every read is the whole store, so incremental copies diff snapshots.
        supportedSyncModes: ['full_refresh', 'incremental'],
        sourceDefinedCursor: true,
        emitsDeletes: true,
      }),
  ),
);
