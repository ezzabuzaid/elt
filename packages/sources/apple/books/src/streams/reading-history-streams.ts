import type { RecordDraft } from '@workspace/elt';
import type {
  ReadingDay,
  ReadingMonth,
  StreakRecord,
} from '@workspace/sdk-apple-books';

import type { BooksScan } from '../books-scan.ts';
import { BooksStream, booksFields } from '../books-stream.ts';

const { nullableInteger } = booksFields;

const pad = (value: number) => String(value).padStart(2, '0');

const monthProperties = {
  month: {
    ...booksFields.text,
    description: 'Calendar month, YYYY-MM, in the time zone Books read in.',
  },
  summarizedSeconds: {
    ...nullableInteger,
    minimum: 0,
    description:
      'Reading time Books kept for the month after summarizing it, in seconds. NULL while the month is not summarized; its days are then in readingDays.',
  },
  lastDayStreakOrdinal: {
    ...nullableInteger,
    description:
      "Books' marker of the month's last streak day, as it stores it; -1 when none.",
  },
  dayCount: {
    ...booksFields.integer,
    minimum: 0,
    description:
      'Days of the month still kept in readingDays; 0 once Books has summarized and pruned them.',
  },
} as const;

export class ReadingMonthsStream extends BooksStream<
  typeof monthProperties,
  ReadingMonth
> {
  readonly name = 'readingMonths';
  readonly store = 'readingHistory';
  readonly primaryKey = ['month'];
  readonly jsonSchema = {
    type: 'object',
    description:
      "One source record per month in Books' reading history, which counts time with a book open for reading goals. Older months keep only a summarized total. Relationships name streams in this source, not physical destination tables.",
    properties: monthProperties,
    required: Object.keys(monthProperties),
  } as const;

  protected rows(scan: BooksScan): readonly ReadingMonth[] {
    return scan.readingHistory.months;
  }

  protected record(month: ReadingMonth): RecordDraft<typeof monthProperties> {
    return {
      month: `${month.year}-${pad(month.month)}`,
      summarizedSeconds: month.totalTime,
      lastDayStreakOrdinal: month.lastDayStreakOrdinal,
      dayCount: month.dayCount,
    };
  }
}

const dayProperties = {
  date: {
    ...booksFields.date,
    description: 'Calendar day, in the time zone Books read in.',
  },
  month: {
    ...booksFields.text,
    description: "The day's month; refers to readingMonths.month.",
  },
  readingSeconds: {
    ...booksFields.integer,
    minimum: 0,
    description:
      'Time spent reading that day, in seconds, summed over every device that synced it.',
  },
  goalSeconds: {
    ...nullableInteger,
    minimum: 0,
    description: 'Daily reading goal in effect that day, in seconds.',
  },
} as const;

export class ReadingDaysStream extends BooksStream<
  typeof dayProperties,
  ReadingDay
> {
  readonly name = 'readingDays';
  readonly store = 'readingHistory';
  readonly primaryKey = ['date'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per day Books still keeps in its reading history, with the time read and the goal. Books summarizes older months into readingMonths and drops their days. Relationships name streams in this source, not physical destination tables.',
    properties: dayProperties,
    required: Object.keys(dayProperties),
  } as const;

  protected rows(scan: BooksScan): readonly ReadingDay[] {
    return scan.readingHistory.days;
  }

  protected record(day: ReadingDay): RecordDraft<typeof dayProperties> {
    const month = `${day.year}-${pad(day.month)}`;
    return {
      date: `${month}-${pad(day.day)}`,
      month,
      readingSeconds: day.readingTime,
      goalSeconds: day.readingGoal,
    };
  }
}

const streakProperties = {
  days: {
    ...booksFields.integer,
    minimum: 1,
    description: 'Length of the streak in consecutive days.',
  },
  reachedAt: {
    ...booksFields.timestamp,
    description:
      'Start of the day the streak first reached this length, in the time zone Books read in.',
  },
} as const;

export class StreakRecordsStream extends BooksStream<
  typeof streakProperties,
  StreakRecord
> {
  readonly name = 'streakRecords';
  readonly store = 'readingHistory';
  readonly primaryKey = ['days'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per reading streak length Books recorded, with when it was first reached. Relationships name streams in this source, not physical destination tables.',
    properties: streakProperties,
    required: Object.keys(streakProperties),
  } as const;

  protected rows(scan: BooksScan): readonly StreakRecord[] {
    return scan.readingHistory.streaks;
  }

  protected record(streak: StreakRecord): RecordDraft<typeof streakProperties> {
    return { days: streak.days, reachedAt: streak.reachedAt.toISOString() };
  }
}
