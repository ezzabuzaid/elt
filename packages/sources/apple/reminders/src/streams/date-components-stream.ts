import type { RecordDraft } from '@workspace/elt';
import type { DateComponentsDocument } from '@workspace/sdk-apple-eventkit';

import {
  AppleRemindersStream,
  remindersFields,
} from '../apple-reminders-stream.ts';
import type { RemindersScan } from '../reminders-scan.ts';

const { id, text, nullableText, boolean, reminderId } = remindersFields;

// The NSDateComponents fields each set keeps, one column each.
const dateComponentNames = [
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

type DateComponentsRow = {
  readonly reminderId: string;
  readonly kind: 'start' | 'due';
  readonly components: DateComponentsDocument;
};

const properties = {
  id: {
    ...id,
    description: 'JSON [reminderId, kind]; unique within this stream.',
  },
  reminderId,
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
        type: ['integer', 'null'] as const,
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
} as const;

export class DateComponentsStream extends AppleRemindersStream<
  typeof properties,
  DateComponentsRow
> {
  readonly name = 'dateComponents';
  readonly jsonSchema = {
    type: 'object',
    description:
      "One source record per start or due date a reminder sets; a reminder without that date has no record. Each record keeps EventKit's NSDateComponents set whole: calendar, time zone, leap month and every component, with a missing component NULL and no manufactured UTC timestamp. A date without a time has NULL hour, minute and second. reminderId refers to reminders.id. Relationships name source streams, not destination tables.",
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: RemindersScan): readonly DateComponentsRow[] {
    return scan.reminders.flatMap((reminder) =>
      (['start', 'due'] as const).flatMap((kind) => {
        const components = reminder[kind];
        return components === undefined
          ? []
          : [{ reminderId: reminder.id, kind, components }];
      }),
    );
  }

  // One start or due component set, kept whole: a missing component stays null
  // instead of becoming a manufactured date.
  protected record({
    reminderId,
    kind,
    components,
  }: DateComponentsRow): RecordDraft<typeof properties> {
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
}
