import type postgres from 'postgres';

import type { Condition } from '@workspace/eca';

// "When I spend over 200 JOD in the first 10 days of a month, tell me": the
// card purchases Arab Bank texts about, by the time of each SMS on the user's
// clock, keyed by month so each month is told once.
export class EarlyMonthSpend implements Condition<
  postgres.Sql,
  { spent: number }
> {
  async evaluate(sql: postgres.Sql) {
    const fils = new Map<string, number>();
    for (const {
      text,
      date,
    } of await sql`SELECT text, date FROM marts.messages_messages WHERE handle = 'Arab Bank'`) {
      if (typeof text !== 'string' || !(date instanceof Date)) continue;
      const amount =
        /تم قيد حركة شراء من حسابكم .* بمبلغ JOD (\d+)\.(\d{3}) /u.exec(text);
      if (amount === null) continue;
      const day = Temporal.Instant.fromEpochMilliseconds(
        date.getTime(),
      ).toZonedDateTimeISO('Asia/Amman');
      if (day.day > 10) continue;
      const month = day.toPlainDate().toPlainYearMonth().toString();
      fils.set(
        month,
        (fils.get(month) ?? 0) + Number(`${amount[1]}${amount[2]}`),
      );
    }
    return [...fils]
      .filter(([, spent]) => spent > 200_000)
      .map(([month, spent]) => ({ key: month, data: { spent: spent / 1000 } }));
  }
}
