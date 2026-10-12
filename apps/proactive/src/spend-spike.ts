import type postgres from 'postgres';

import type { Match } from '@workspace/eca';

import { NotifyAutomation } from './notify-automation.ts';

// "When a week's card spend passes twice my usual, tell me": the card
// purchases Arab Bank texts about, by the time of each SMS on the user's
// clock, summed per ISO week. A week matches when it passes twice the median
// of the 8 weeks before it, where a week without purchases counts as 0, keyed
// by week so each week is told once. early-month-spend.ts parses the same
// template; a fix to the parse belongs in both (ADR 0004 of eca).
export class SpendSpike extends NotifyAutomation<{
  spent: number;
  usual: number;
}> {
  message({ key, data }: Match<{ spent: number; usual: number }>) {
    return `You spent ${data.spent} JOD in ${key}, over twice your usual ${data.usual} JOD a week.`;
  }

  async evaluate(sql: postgres.Sql) {
    const fils = new Map<string, number>();
    let first: Temporal.PlainDate | undefined;
    let last: Temporal.PlainDate | undefined;
    for (const {
      text,
      date,
    } of await sql`SELECT text, date FROM marts.messages_messages WHERE handle = 'Arab Bank'`) {
      if (typeof text !== 'string' || !(date instanceof Date)) continue;
      const amount =
        /تم قيد حركة شراء من حسابكم .* بمبلغ JOD (\d+)\.(\d{3}) /u.exec(text);
      if (amount === null) continue;
      const day = Temporal.Instant.fromEpochMilliseconds(date.getTime())
        .toZonedDateTimeISO('Asia/Amman')
        .toPlainDate();
      const monday = day.subtract({ days: day.dayOfWeek - 1 });
      fils.set(
        monday.toString(),
        (fils.get(monday.toString()) ?? 0) + Number(`${amount[1]}${amount[2]}`),
      );
      if (first === undefined || Temporal.PlainDate.compare(monday, first) < 0)
        first = monday;
      if (last === undefined || Temporal.PlainDate.compare(monday, last) > 0)
        last = monday;
    }
    const weeks: { monday: Temporal.PlainDate; spent: number }[] = [];
    for (
      let monday = first;
      monday !== undefined &&
      last !== undefined &&
      Temporal.PlainDate.compare(monday, last) <= 0;
      monday = monday.add({ weeks: 1 })
    )
      weeks.push({ monday, spent: fils.get(monday.toString()) ?? 0 });
    return weeks.slice(8).flatMap(({ monday, spent }, index) => {
      const [, , , low = 0, high = 0] = weeks
        .slice(index, index + 8)
        .map((week) => week.spent)
        .toSorted((a, b) => a - b);
      return spent > low + high
        ? [
            {
              key: `${monday.yearOfWeek}-W${String(monday.weekOfYear).padStart(2, '0')}`,
              data: {
                spent: spent / 1000,
                usual: Math.round((low + high) / 2) / 1000,
              },
            },
          ]
        : [];
    });
  }
}
