import type postgres from 'postgres';

import type { Reading } from '@eltjs/eca';

import { NotifyAutomation } from '../../engine/notify-automation.ts';

type Missing = { readonly month: string; readonly due: string };

// "When the mid-month credit has not arrived by day 18, tell me": an Arab
// Bank credit of 1000 JOD or more is due on days 13 to 17 of each month, on
// the user's clock. A month is missing from its day 18 until such a credit
// arrives, and it matches when it is missing after and was not before. Day 18
// starts when the warehouse holds a message from it, not by the wall clock,
// so an import that is behind tells nothing.
export class MissingMidMonthCredit extends NotifyAutomation<Missing> {
  message({ month, due }: Missing) {
    return `The mid-month credit of ${month} has not arrived. It was due by ${due}.`;
  }

  async evaluate(before: Reading<postgres.Sql>, after: Reading<postgres.Sql>) {
    const was = new Set((await missing(before.sql)).map(({ month }) => month));
    return (await missing(after.sql)).filter(({ month }) => !was.has(month));
  }
}

async function missing(sql: postgres.Sql): Promise<Missing[]> {
  const [latest] =
    await sql`SELECT max(date) AS date FROM marts.messages_messages`;
  if (!(latest?.date instanceof Date)) return [];
  const reached = amman(latest.date);
  const credited = new Set<string>();
  let first: Temporal.PlainYearMonth | undefined;
  for (const {
    text,
    date,
  } of await sql`SELECT text, date FROM marts.messages_messages WHERE handle = 'Arab Bank'`) {
    if (typeof text !== 'string' || !(date instanceof Date)) continue;
    const amount = /قيد حوالة بمبلغ JOD (\d+)\.(\d{3}) لحساب/u.exec(text);
    if (amount === null || Number(`${amount[1]}${amount[2]}`) < 1_000_000)
      continue;
    const day = amman(date);
    if (day.day < 13) continue;
    const month = day.toPlainYearMonth();
    credited.add(month.toString());
    if (
      first === undefined ||
      Temporal.PlainYearMonth.compare(month, first) < 0
    )
      first = month;
  }
  const late: Missing[] = [];
  for (
    let month = first;
    month !== undefined &&
    Temporal.PlainDate.compare(month.toPlainDate({ day: 18 }), reached) <= 0;
    month = month.add({ months: 1 })
  )
    if (!credited.has(month.toString()))
      late.push({
        month: month.toString(),
        due: month.toPlainDate({ day: 17 }).toString(),
      });
  return late;
}

function amman(date: Date) {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime())
    .toZonedDateTimeISO('Asia/Amman')
    .toPlainDate();
}
