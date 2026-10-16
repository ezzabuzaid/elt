import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Docker, TestRun } from '@zukhruf/testing/docker';
import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

import { Eca } from '@workspace/eca';

import { MissingMidMonthCredit } from './missing-mid-month-credit.ts';
import { SpendSpike } from './spend-spike.ts';

const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });
const postgresql = new Postgres({ docker });

async function createMessagesSchema(sql: postgres.Sql): Promise<void> {
  await sql`CREATE SCHEMA marts`;
  await sql`CREATE TABLE marts.messages_messages (
    guid text PRIMARY KEY, handle text, text text, "isFromMe" boolean,
    date timestamptz
  )`;
}

// Writes received SMS the way the Messages load does: one row each, and
// no date when chat.db holds none.
async function receive(
  sql: postgres.Sql,
  ...messages: readonly [handle: string, text: string, date: string | null][]
): Promise<void> {
  await sql`INSERT INTO marts.messages_messages ${sql(
    messages.map(([handle, text, date]) => ({
      guid: randomUUID(),
      handle,
      text,
      isFromMe: false,
      date,
    })),
  )}`;
}

// The Arab Bank templates, as the SMS in the Messages import read, with the
// numbers changed.
const credit = (jod: string) =>
  `JO\n قيد حوالة بمبلغ JOD ${jod} لحساب 123*4567 الرصيد المتوفر 10000.000`;
const purchase = (jod: string) =>
  `JO\nتم قيد حركة شراء من حسابكم 123*4567 من Careem Food بمبلغ JOD ${jod} بتاريخ 04/03/2026 12:00 .الرصيد 10000.000 دينار اردني.`;
const other = 'Hello';

const sent =
  'JO\nقيدت حوالة بمبلغ JOD 1500.000 من حساب 123*4567 لحساب 1234*567 . الرصيد JOD 10000.000 .';

// One purchase a week, on the Wednesdays from 7 January 2026 (2026-W02), so
// with eight amounts the week of 2 March is the ninth week, 2026-W10.
const weeks = (...amounts: readonly string[]) =>
  amounts.map((jod, week): [string, string, string] => [
    'Arab Bank',
    purchase(jod),
    `${Temporal.PlainDate.from('2026-01-07').add({ weeks: week }).toString()}T09:00:00Z`,
  ]);
const eightUsualWeeks = weeks(...Array.from({ length: 8 }, () => '100.000'));

test('a month without its credit matches only once the warehouse holds a message from day 18 on the Amman clock', async () => {
  await using database = await postgresql.database();
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(database.connectionString, { max: 1, onnotice: () => {} }),
    (sql) => sql.end(),
  );
  await createMessagesSchema(sql);
  const rule = new MissingMidMonthCredit();

  assert.deepEqual(await rule.evaluate(sql), [], 'an empty warehouse');

  await receive(
    sql,
    ['Arab Bank', credit('1500.000'), '2026-02-14T09:00:00Z'],
    ['Mom', other, '2026-03-17T20:00:00Z'],
  );

  assert.deepEqual(
    await rule.evaluate(sql),
    [],
    'at 23:00 on 17 March in Amman, the credit is not late yet',
  );

  await receive(sql, ['Mom', other, '2026-03-17T21:30:00Z']);

  assert.deepEqual(await rule.evaluate(sql), [
    { key: '2026-03', data: { due: '2026-03-17' } },
  ]);
});

test('only an Arab Bank credit of 1000 JOD or more from day 13 is the mid-month credit', async () => {
  await using database = await postgresql.database();
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(database.connectionString, { max: 1, onnotice: () => {} }),
    (sql) => sql.end(),
  );
  await createMessagesSchema(sql);
  await receive(
    sql,
    ['Arab Bank', credit('1500.000'), '2026-02-14T09:00:00Z'],
    ['Arab Bank', credit('1500.000'), '2026-03-12T20:00:00Z'],
    ['Arab Bank', credit('999.999'), '2026-03-14T09:00:00Z'],
    ['Arab Bank', sent, '2026-03-14T10:00:00Z'],
    ['Safwa Bank', credit('1500.000'), '2026-03-15T09:00:00Z'],
    ['Arab Bank', credit('1500.000'), null],
    ['Arab Bank', credit('1000.000'), '2026-04-14T09:00:00Z'],
    ['Mom', other, '2026-04-18T09:00:00Z'],
  );

  assert.deepEqual(
    await new MissingMidMonthCredit().evaluate(sql),
    [{ key: '2026-03', data: { due: '2026-03-17' } }],
    'March, between two credited months, has only a credit at 23:00 on day 12 in Amman, one under 1000 JOD, a transfer the user sent, another bank’s credit and one without a date',
  );
});

test('the commit that reaches day 18 without the credit tells its month once, and a credit just after midnight on day 13 tells nothing', async () => {
  await using database = await postgresql.database();
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(database.connectionString, { max: 1, onnotice: () => {} }),
    (sql) => sql.end(),
  );
  await createMessagesSchema(sql);
  await receive(
    sql,
    ['Arab Bank', credit('1500.000'), '2026-02-14T09:00:00Z'],
    ['Mom', other, '2026-03-17T20:00:00Z'],
  );
  const rule = { condition: new MissingMidMonthCredit() };
  const eca = new Eca<postgres.Sql, { due: string }>({
    warehouse: {
      sql,
      async *commits() {
        yield;
      },
    },
  });
  await eca.add(rule);
  const watch = () =>
    Array.fromAsync(eca.watch({ signal: new AbortController().signal }));

  await receive(sql, ['Mom', other, '2026-03-18T09:00:00Z']);
  assert.deepEqual(await watch(), [
    { rule, key: '2026-03', data: { due: '2026-03-17' } },
  ]);
  assert.deepEqual(await watch(), [], 'a missing credit is told once');

  await receive(
    sql,
    ['Arab Bank', credit('1500.000'), '2026-04-12T21:30:00Z'],
    ['Mom', other, '2026-04-18T09:00:00Z'],
  );
  assert.deepEqual(
    await watch(),
    [],
    '00:30 on 13 April in Amman is in the window',
  );
});

test('a one-time code, a credit, a transfer the user sent, or a forwarded purchase is not spend', async () => {
  await using database = await postgresql.database();
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(database.connectionString, { max: 1, onnotice: () => {} }),
    (sql) => sql.end(),
  );
  await createMessagesSchema(sql);
  await receive(
    sql,
    ...eightUsualWeeks,
    ['Arab Bank', purchase('150.000'), '2026-03-04T09:00:00Z'],
    [
      'Arab Bank',
      'JO\nلا تشارك رمز التفعيل\nرمز التفعيل لمرة واحدة: 123456 \nالغاية: حركة شراء بمبلغ 900.00 JOD من JOBEDU \nتطبق عمولة على الحركات الدولية',
      '2026-03-04T10:00:00Z',
    ],
    ['Arab Bank', credit('1500.000'), '2026-03-04T11:00:00Z'],
    ['Arab Bank', sent, '2026-03-04T12:00:00Z'],
    ['Mom', purchase('900.000'), '2026-03-04T13:00:00Z'],
    ['Arab Bank', purchase('900.000'), null],
  );
  const rule = new SpendSpike();

  assert.deepEqual(await rule.evaluate(sql), []);

  await receive(sql, ['Arab Bank', purchase('60.000'), '2026-03-05T09:00:00Z']);

  assert.deepEqual(await rule.evaluate(sql), [
    { key: '2026-W10', data: { spent: 210, usual: 100 } },
  ]);
});

test('a week without purchases counts as 0 in the usual spend', async () => {
  await using database = await postgresql.database();
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(database.connectionString, { max: 1, onnotice: () => {} }),
    (sql) => sql.end(),
  );
  await createMessagesSchema(sql);
  await receive(sql, ...weeks('100.000', '100.000', '200.000', '200.000'), [
    'Arab Bank',
    purchase('150.000'),
    '2026-03-04T09:00:00Z',
  ]);

  assert.deepEqual(
    await new SpendSpike().evaluate(sql),
    [{ key: '2026-W10', data: { spent: 150, usual: 50 } }],
    'weeks of 100, 100, 200 and 200 JOD and four of none make 50 JOD usual',
  );
});

test('the usual spend is the median of the 8 weeks before the week, without the week itself', async () => {
  await using database = await postgresql.database();
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(database.connectionString, { max: 1, onnotice: () => {} }),
    (sql) => sql.end(),
  );
  await createMessagesSchema(sql);
  await receive(
    sql,
    ...weeks(
      '100.000',
      '100.000',
      '100.000',
      '100.000',
      '300.000',
      '300.000',
      '300.000',
      '1000.000',
    ),
    ['Arab Bank', purchase('500.000'), '2026-03-04T09:00:00Z'],
  );

  assert.deepEqual(
    await new SpendSpike().evaluate(sql),
    [{ key: '2026-W10', data: { spent: 500, usual: 200 } }],
    'the mean, 287.5 JOD, or a median with the week itself, 300 JOD, would not tell',
  );
});

test('a commit that takes a week past twice its usual spend tells the week once, and exactly twice tells nothing', async () => {
  await using database = await postgresql.database();
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(database.connectionString, { max: 1, onnotice: () => {} }),
    (sql) => sql.end(),
  );
  await createMessagesSchema(sql);
  await receive(sql, ...eightUsualWeeks);
  const rule = { condition: new SpendSpike() };
  const eca = new Eca<postgres.Sql, { spent: number; usual: number }>({
    warehouse: {
      sql,
      async *commits() {
        yield;
      },
    },
  });
  await eca.add(rule);
  const watch = () =>
    Array.fromAsync(eca.watch({ signal: new AbortController().signal }));

  await receive(sql, [
    'Arab Bank',
    purchase('200.000'),
    '2026-03-04T09:00:00Z',
  ]);
  assert.deepEqual(await watch(), [], 'exactly twice is not past twice');

  await receive(sql, ['Arab Bank', purchase('0.001'), '2026-03-04T10:00:00Z']);
  assert.deepEqual(await watch(), [
    { rule, key: '2026-W10', data: { spent: 200.001, usual: 100 } },
  ]);

  await receive(sql, ['Arab Bank', purchase('50.000'), '2026-03-05T09:00:00Z']);
  assert.deepEqual(await watch(), [], 'a week is told once');
});

test('a purchase just after midnight on Monday in Amman counts in the new ISO week, across the new year', async () => {
  await using database = await postgresql.database();
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(database.connectionString, { max: 1, onnotice: () => {} }),
    (sql) => sql.end(),
  );
  await createMessagesSchema(sql);
  await receive(
    sql,
    ...[
      '2024-11-06',
      '2024-11-13',
      '2024-11-20',
      '2024-11-27',
      '2024-12-04',
      '2024-12-11',
      '2024-12-18',
      '2024-12-25',
    ].map((day): [string, string, string] => [
      'Arab Bank',
      purchase('100.000'),
      `${day}T09:00:00Z`,
    ]),
    ['Arab Bank', purchase('150.000'), '2024-12-29T22:30:00Z'],
    ['Arab Bank', purchase('60.000'), '2025-01-01T09:00:00Z'],
  );

  assert.deepEqual(
    await new SpendSpike().evaluate(sql),
    [{ key: '2025-W01', data: { spent: 210, usual: 100 } }],
    'Monday 30 December 2024 starts 2025-W01',
  );
});
