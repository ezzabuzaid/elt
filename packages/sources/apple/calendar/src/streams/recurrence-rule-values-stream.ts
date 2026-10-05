import type { RecordDraft } from '@workspace/elt';

import type { CalendarScan } from '../calendar-scan.ts';
import {
  CalendarStream,
  calendarFields,
  perOccurrence,
} from '../calendar-stream.ts';

const { id, eventId, text, ordinal, integer } = calendarFields;

const properties = {
  id: {
    ...id,
    description:
      'JSON [ruleId, component, position]; unique within this stream.',
  },
  eventId,
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

// The rule lists other than daysOfTheWeek, which hold plain numbers.
const numberLists = [
  'daysOfTheMonth',
  'daysOfTheYear',
  'weeksOfTheYear',
  'monthsOfTheYear',
  'setPositions',
] as const;

type Row = {
  readonly eventId: string;
  readonly ruleId: string;
  readonly component: string;
  readonly position: number;
  readonly value: number;
  readonly weekNumber: number | null;
};

export class RecurrenceRuleValuesStream extends CalendarStream<
  typeof properties,
  Row
> {
  readonly name = 'recurrenceRuleValues';
  readonly jsonSchema = {
    type: 'object',
    description: `One source record per entry of a recurrence rule's day, week, month or set-position lists. ${perOccurrence} ruleId refers to recurrenceRules.id and eventId to events.eventId. Relationships name source streams, not destination tables.`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: CalendarScan): readonly Row[] {
    return scan.rules.flatMap(({ eventId, ruleId, rule }) => [
      ...rule.daysOfTheWeek.map((day, position) => ({
        eventId,
        ruleId,
        component: 'daysOfTheWeek',
        position,
        value: day.day,
        weekNumber: day.weekNumber,
      })),
      ...numberLists.flatMap((component) =>
        rule[component].map((value, position) => ({
          eventId,
          ruleId,
          component,
          position,
          value,
          weekNumber: null,
        })),
      ),
    ]);
  }

  protected record(row: Row): RecordDraft<typeof properties> {
    return {
      id: JSON.stringify([row.ruleId, row.component, row.position]),
      eventId: row.eventId,
      ruleId: row.ruleId,
      component: row.component,
      position: row.position,
      value: row.value,
      weekNumber: row.weekNumber,
    };
  }
}
