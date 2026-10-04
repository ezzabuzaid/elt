import type { RecordDraft } from '@workspace/elt';

import {
  AppleRemindersStream,
  remindersFields,
} from '../apple-reminders-stream.ts';
import {
  type RemindersScan,
  type RuleEntry,
  timestamp,
} from '../reminders-scan.ts';

const { id, text, ordinal, integer, nullableTimestamp, reminderId } =
  remindersFields;

const properties = {
  id: {
    ...id,
    description:
      'JSON [reminderId, "recurrenceRule", position]; recurrenceRuleValues.ruleId refers to it.',
  },
  reminderId,
  position: {
    ...ordinal,
    description:
      'Index in EventKit EKCalendarItem.recurrenceRules, in the order EventKit returns them.',
  },
  calendarIdentifier: {
    ...text,
    description:
      'EventKit EKRecurrenceRule.calendarIdentifier: the calendar system the rule uses.',
  },
  frequency: {
    ...ordinal,
    description:
      'EventKit EKRecurrenceRule.frequency raw value (EKRecurrenceFrequency): 0 daily, 1 weekly, 2 monthly, 3 yearly. Unknown codes are kept as numbers.',
  },
  interval: {
    ...integer,
    minimum: 1,
    description:
      'EventKit EKRecurrenceRule.interval: the rule repeats every interval frequency units, such as 2 with weekly for every other week.',
  },
  firstDayOfWeek: {
    ...integer,
    minimum: 0,
    maximum: 7,
    description:
      'EventKit EKRecurrenceRule.firstDayOfTheWeek: 1 Sunday through 7 Saturday; 0 when the rule does not set it.',
  },
  endAt: {
    ...nullableTimestamp,
    description:
      'EventKit EKRecurrenceRule.recurrenceEnd.endDate as a UTC timestamp; NULL when the rule ends after a count or never ends.',
  },
  occurrenceCount: {
    ...ordinal,
    description:
      'EventKit EKRecurrenceRule.recurrenceEnd.occurrenceCount; 0 when the rule ends at endAt or never ends. endAt NULL with 0 here means no end.',
  },
} as const;

export class RecurrenceRulesStream extends AppleRemindersStream<
  typeof properties,
  RuleEntry
> {
  readonly name = 'recurrenceRules';
  readonly jsonSchema = {
    type: 'object',
    description:
      "One source record per EventKit recurrence rule of a reminder. reminderId refers to reminders.id; recurrenceRuleValues holds each rule's list values. Relationships name source streams, not destination tables.",
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: RemindersScan): readonly RuleEntry[] {
    return scan.rules;
  }

  protected record({
    reminderId,
    ruleId,
    position,
    rule,
  }: RuleEntry): RecordDraft<typeof properties> {
    return {
      id: ruleId,
      reminderId,
      position,
      calendarIdentifier: rule.calendarIdentifier ?? null,
      frequency: rule.frequency,
      interval: rule.interval,
      firstDayOfWeek: rule.firstDayOfWeek,
      endAt: timestamp(rule.end?.endMs),
      occurrenceCount: rule.end?.occurrenceCount ?? 0,
    };
  }
}
