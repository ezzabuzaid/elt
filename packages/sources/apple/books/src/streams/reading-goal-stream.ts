import type { RecordDraft } from '@workspace/elt';
import type { ReadingGoal } from '@workspace/sdk-apple-books';

import type { BooksScan } from '../books-scan.ts';
import { BooksStream, booksFields, iso } from '../books-stream.ts';

const { nullableBoolean, nullableInteger, nullableTimestamp } = booksFields;

const properties = {
  id: {
    ...booksFields.id,
    enum: ['current'],
    description: 'Always current: Books keeps one reading goal.',
  },
  enabled: {
    ...nullableBoolean,
    description: 'Whether reading goals are turned on; NULL when never set.',
  },
  dailyGoalSeconds: {
    ...nullableInteger,
    minimum: 0,
    description: 'Daily reading goal in seconds; NULL when never set.',
  },
  goalSetAt: {
    ...nullableTimestamp,
    description: 'When the daily goal was last set.',
  },
  currentStreakDays: {
    ...nullableInteger,
    minimum: 0,
    description:
      'Consecutive days the goal has been met, as Books last computed it.',
  },
} as const;

export class ReadingGoalStream extends BooksStream<
  typeof properties,
  ReadingGoal
> {
  readonly name = 'readingGoal';
  readonly store = 'preferences';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      "The Books reading goal and current streak, one record, from Books' preferences. Daily reading time is in readingDays. Relationships name streams in this source, not physical destination tables.",
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: BooksScan): readonly ReadingGoal[] {
    return [scan.readingGoal];
  }

  protected record(goal: ReadingGoal): RecordDraft<typeof properties> {
    return {
      id: 'current',
      enabled: goal.enabled,
      dailyGoalSeconds: goal.dailyGoalSeconds,
      goalSetAt: iso(goal.goalSetAt),
      currentStreakDays: goal.currentStreakDays,
    };
  }
}
