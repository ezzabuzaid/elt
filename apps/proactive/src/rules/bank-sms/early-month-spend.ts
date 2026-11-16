import type postgres from 'postgres';

import type { Reading } from '@eltjs/eca';

import { NotifyAutomation } from '../../engine/notify-automation.ts';

type Spend = { readonly month: string; readonly spent: number };

// "When I spend over 200 JOD in the first 10 days of a month, tell me": the
// card purchases Arab Bank texts about, by the time of each SMS on the user's
// clock. A month matches when it passes 200 JOD after and did not before.
export class EarlyMonthSpend extends NotifyAutomation<Spend> {
  message({ month, spent }: Spend) {
    return `You spent ${spent} JOD in the first 10 days of ${month}.`;
  }

  async evaluate(before: Reading<postgres.Sql>, after: Reading<postgres.Sql>) {
    const was = await overLimit(before.sql);
    return [...(await overLimit(after.sql))]
      .filter(([month]) => !was.has(month))
      .map(([month, spent]) => ({ month, spent }));
  }
}

// The JOD spent in days 1 to 10 of each month that passes 200 JOD.
async function overLimit(sql: postgres.Sql): Promise<Map<string, number>> {
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
  return new Map(
    [...fils]
      .filter(([, spent]) => spent > 200_000)
      .map(([month, spent]) => [month, spent / 1000]),
  );
}
