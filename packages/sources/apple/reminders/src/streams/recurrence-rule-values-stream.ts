import type { RecordDraft } from '@workspace/elt';

import {
  AppleRemindersStream,
  remindersFields,
} from '../apple-reminders-stream.ts';
import type { RemindersScan } from '../reminders-scan.ts';

const { id, text, ordinal, integer, reminderId } = remindersFields;

// The EKRecurrenceRule number lists besides daysOfTheWeek, in this order.
const numberLists = [
  'daysOfTheMonth',
  'daysOfTheYear',
  'weeksOfTheYear',
  'monthsOfTheYear',
  'setPositions',
] as const;

type ValueRow = {
  readonly reminderId: string;
  readonly ruleId: string;
  readonly component: string;
  readonly position: number;
  readonly value: number;
  readonly weekNumber: number | null;
};

const properties = {
  id: {
    ...id,
    description:
      'JSON [ruleId, component, position]; unique within this stream.',
  },
  reminderId,
  ruleId: {
    ...id,
    description:
      'Owning rule; refers to recurrenceRules.id within this source.',
  },
  component: {
    ...text,
    description:
      'The EventKit EKRecurrenceRule list property this value belongs to: daysOfTheWeek (iCalendar BYDAY), daysOfTheMonth (BYMONTHDAY), daysOfTheYear (BYYEARDAY), weeksOfTheYear (BYWEEKNO), monthsOfTheYear (BYMONTH) or setPositions (BYSETPOS).',
  },
  position: {
    ...ordinal,
    description:
      'Index in that EventKit list, in the order EventKit returns it.',
  },
  value: {
    ...integer,
    description:
      'For daysOfTheWeek, EKRecurrenceDayOfWeek.dayOfTheWeek (EKWeekday): 1 Sunday through 7 Saturday. Otherwise the list entry; negative values count from the end of the month or year (setPositions: from the end of the set).',
  },
  weekNumber: {
    type: ['integer', 'null'],
    description:
      "For daysOfTheWeek, EventKit EKRecurrenceDayOfWeek.weekNumber, which Apple's plain dayOfWeek: constructor sets to 0; NULL for every other component.",
  },
} as const;

export class RecurrenceRuleValuesStream extends AppleRemindersStream<
  typeof properties,
  ValueRow
> {
  readonly name = 'recurrenceRuleValues';
  readonly jsonSchema = {
    type: 'object',
    description:
      "One source record per entry of a recurrence rule's day, week, month or set-position lists. ruleId refers to recurrenceRules.id and reminderId to reminders.id. Relationships name source streams, not destination tables.",
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: RemindersScan): readonly ValueRow[] {
    return scan.rules.flatMap(({ reminderId, ruleId, rule }) => [
      ...rule.daysOfTheWeek.map((day, position) => ({
        reminderId,
        ruleId,
        component: 'daysOfTheWeek',
        position,
        value: day.day,
        weekNumber: day.weekNumber,
      })),
      ...numberLists.flatMap((component) =>
        rule[component].map((value, position) => ({
          reminderId,
          ruleId,
          component,
          position,
          value,
          weekNumber: null,
        })),
      ),
    ]);
  }

  protected record(row: ValueRow): RecordDraft<typeof properties> {
    return {
      id: JSON.stringify([row.ruleId, row.component, row.position]),
      reminderId: row.reminderId,
      ruleId: row.ruleId,
      component: row.component,
      position: row.position,
      value: row.value,
      weekNumber: row.weekNumber,
    };
  }
}
