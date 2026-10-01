import type { SchemaRecord } from 'elt';
import type { PlistValue } from '../../../platform/macos/plist.ts';
import type { BooksScan, Preferences } from '../books-scan.ts';
import { BooksStream, booksFields } from '../books-stream.ts';
import { integer, plistTime } from '../books-values.ts';

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

const dictionary = (value: PlistValue | undefined) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  !(value instanceof Uint8Array)
    ? (value as Readonly<Record<string, PlistValue>>)
    : {};

export class ReadingGoalStream extends BooksStream<
  typeof properties,
  Preferences
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

  protected rows(scan: BooksScan): readonly Preferences[] {
    return [scan.preferences];
  }

  protected record({
    app,
    shared,
  }: Preferences): SchemaRecord<typeof properties> {
    const appValues = dictionary(app);
    const sharedValues = dictionary(shared);
    const goal = dictionary(sharedValues.streakDatUserDefaultsKey);
    const appGoal = dictionary(appValues['ReadingGoals.StreakDay']);
    const enabled = sharedValues.BKReadingGoalsUserDefaultsKey;
    return {
      id: 'current',
      enabled: typeof enabled === 'boolean' ? enabled : null,
      dailyGoalSeconds: integer(appGoal.goal) ?? integer(goal.goal),
      goalSetAt: plistTime(goal.date) ?? plistTime(appGoal.date),
      currentStreakDays: integer(appValues['ReadingHistory.CurrentStreak']),
    };
  }
}
