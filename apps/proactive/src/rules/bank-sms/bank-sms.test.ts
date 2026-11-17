import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Postgres } from '@zukhruf/testing/postgres';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  Gauge,
  Pipeline,
  Source,
  Stream,
} from '@eltjs/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@eltjs/elt-postgresql';

import type { Automation } from '../../engine/automation.ts';
import { EarlyMonthSpend } from './early-month-spend.ts';
import { MissingMidMonthCredit } from './missing-mid-month-credit.ts';
import { SpendSpike } from './spend-spike.ts';

const postgresql = new Postgres({ environment: process.env });

type Sms = {
  guid: string;
  handle: string;
  text: string;
  isFromMe: boolean;
  date: string | null;
};

const messages = new Stream({
  name: 'messages_messages',
  jsonSchema: {
    type: 'object',
    description: 'A message.',
    properties: {
      guid: { type: 'string', description: 'Its id.' },
      handle: { type: 'string', description: 'Who sent it.' },
      text: { type: 'string', description: 'What it says.' },
      isFromMe: { type: 'boolean', description: 'Whether the user sent it.' },
      date: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'When it was sent.',
      },
    },
    required: ['guid', 'handle', 'text', 'isFromMe', 'date'],
  },
  primaryKey: ['guid'],
  supportedSyncModes: ['full_refresh'],
});

// The upstream of the test source, which the test fills before it reads.
class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// Reads every SMS received so far, as an upstream that replaces its table
// whole.
class Received extends Source {
  readonly identity = 'received';
  protected readonly catalog = new Catalog([messages]);
  readonly #sms: readonly Sms[];

  constructor(sms: readonly Sms[]) {
    super();
    this.#sms = sms;
  }

  override coverage() {
    return { description: 'test', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  override changeSignals(streams: readonly Stream[]): ChangeSignal[] {
    return [{ gauge: new Filled(), streams, interval: 1000, timeout: 1000 }];
  }

  protected override async *extract() {
    for (const data of this.#sms) yield { stream: messages.name, data };
  }
}

// The Messages import in a warehouse: each load gives marts.messages_messages
// every SMS received so far, and a rule reads it as of two loads.
function inbox(url: string) {
  const destination = new PostgresDestination({ url, schema: 'raw' });
  const checkpoints = new PostgresCheckpointStore({ url, schema: 'raw' });
  const history = new PostgresSyncHistory({ url });
  const copy = new Copy(
    messages,
    destination
      .table('messages_messages')
      .withReaderView('marts', 'messages_messages'),
    {
      id: 'messages',
      syncMode: 'full_refresh',
      destinationSyncMode: 'overwrite',
    },
  );
  const received: Sms[] = [];
  return {
    // Receives SMS the way the Messages load writes them, one row each, a
    // date as Date#toISOString writes it and no date when chat.db holds none,
    // and loads them. Resolves to the position of the load.
    async receive(
      ...sms: readonly [handle: string, text: string, date: string | null][]
    ): Promise<string> {
      received.push(
        ...sms.map(([handle, text, date]) => ({
          guid: randomUUID(),
          handle,
          text,
          isFromMe: false,
          date: date === null ? null : new Date(date).toISOString(),
        })),
      );
      await new Pipeline({
        clock: globalThis,
        history,
        connections: [
          new Connection({
            name: 'messages',
            source: new Received([...received]),
            destination,
            checkpoints,
            steps: [copy],
          }),
        ],
      }).run();
      const positions = await destination.positions();
      if ('expired' in positions) assert.fail(positions.expired);
      const position = positions.at(-1);
      assert.ok(position !== undefined, 'the load made a position');
      return position;
    },
    // What the rule gives between the warehouse as of two positions.
    async evaluate<Data>(
      rule: Automation<Data>,
      from: string,
      to: string,
    ): Promise<readonly Data[]> {
      const before = await destination.reading(from);
      if ('expired' in before) assert.fail(before.expired);
      await using _before = before;
      const after = await destination.reading(to);
      if ('expired' in after) assert.fail(after.expired);
      await using _after = after;
      return await rule.evaluate(before, after);
    },
  };
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
  const warehouse = inbox(database.connectionString);
  const rule = new MissingMidMonthCredit();
  const empty = await warehouse.receive();
  const eleven = await warehouse.receive(
    ['Arab Bank', credit('1500.000'), '2026-02-14T09:00:00Z'],
    ['Mom', other, '2026-03-17T20:00:00Z'],
  );
  const midnight = await warehouse.receive([
    'Mom',
    other,
    '2026-03-17T21:30:00Z',
  ]);

  assert.deepEqual(
    await warehouse.evaluate(rule, empty, empty),
    [],
    'an empty warehouse',
  );
  assert.deepEqual(
    await warehouse.evaluate(rule, empty, eleven),
    [],
    'at 23:00 on 17 March in Amman, the credit is not late yet',
  );
  assert.deepEqual(await warehouse.evaluate(rule, eleven, midnight), [
    { month: '2026-03', due: '2026-03-17' },
  ]);
});

test('only an Arab Bank credit of 1000 JOD or more from day 13 is the mid-month credit', async () => {
  await using database = await postgresql.database();
  const warehouse = inbox(database.connectionString);
  const empty = await warehouse.receive();
  const received = await warehouse.receive(
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
    await warehouse.evaluate(new MissingMidMonthCredit(), empty, received),
    [{ month: '2026-03', due: '2026-03-17' }],
    'March, between two credited months, has only a credit at 23:00 on day 12 in Amman, one under 1000 JOD, a transfer the user sent, another bank’s credit and one without a date',
  );
});

test('the load that reaches day 18 without the credit tells its month once, and a credit just after midnight on day 13 tells nothing', async () => {
  await using database = await postgresql.database();
  const warehouse = inbox(database.connectionString);
  const rule = new MissingMidMonthCredit();
  const before = await warehouse.receive(
    ['Arab Bank', credit('1500.000'), '2026-02-14T09:00:00Z'],
    ['Mom', other, '2026-03-17T20:00:00Z'],
  );
  const late = await warehouse.receive(['Mom', other, '2026-03-18T09:00:00Z']);
  const april = await warehouse.receive(
    ['Arab Bank', credit('1500.000'), '2026-04-12T21:30:00Z'],
    ['Mom', other, '2026-04-18T09:00:00Z'],
  );

  assert.deepEqual(await warehouse.evaluate(rule, before, late), [
    { month: '2026-03', due: '2026-03-17' },
  ]);
  assert.deepEqual(
    await warehouse.evaluate(rule, late, april),
    [],
    'March, still missing, is told once, and 00:30 on 13 April in Amman is in the window',
  );
});

test('a month matches when its card purchases in days 1 to 10 on the Amman clock pass 200 JOD', async () => {
  await using database = await postgresql.database();
  const warehouse = inbox(database.connectionString);
  const rule = new EarlyMonthSpend();
  const under = await warehouse.receive(
    ['Arab Bank', purchase('150.000'), '2026-10-02T09:00:00Z'],
    ['Arab Bank', purchase('50.000'), '2026-10-10T20:30:00Z'],
    ['Arab Bank', purchase('900.000'), '2026-10-10T21:30:00Z'],
  );
  const over = await warehouse.receive([
    'Arab Bank',
    purchase('0.001'),
    '2026-10-05T09:00:00Z',
  ]);
  const more = await warehouse.receive([
    'Arab Bank',
    purchase('10.000'),
    '2026-10-06T09:00:00Z',
  ]);

  assert.deepEqual(
    await warehouse.evaluate(rule, under, over),
    [{ month: '2026-10', spent: 200.001 }],
    '00:30 on 11 October in Amman is past day 10',
  );
  assert.deepEqual(
    await warehouse.evaluate(rule, over, more),
    [],
    'a month is told once',
  );
});

test('a one-time code, a credit, a transfer the user sent, or a forwarded purchase is not spend', async () => {
  await using database = await postgresql.database();
  const warehouse = inbox(database.connectionString);
  const rule = new SpendSpike();
  const empty = await warehouse.receive();
  const usual = await warehouse.receive(
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
  const spike = await warehouse.receive([
    'Arab Bank',
    purchase('60.000'),
    '2026-03-05T09:00:00Z',
  ]);

  assert.deepEqual(await warehouse.evaluate(rule, empty, usual), []);
  assert.deepEqual(await warehouse.evaluate(rule, usual, spike), [
    { week: '2026-W10', spent: 210, usual: 100 },
  ]);
});

test('a week without purchases counts as 0 in the usual spend', async () => {
  await using database = await postgresql.database();
  const warehouse = inbox(database.connectionString);
  const empty = await warehouse.receive();
  const received = await warehouse.receive(
    ...weeks('100.000', '100.000', '200.000', '200.000'),
    ['Arab Bank', purchase('150.000'), '2026-03-04T09:00:00Z'],
  );

  assert.deepEqual(
    await warehouse.evaluate(new SpendSpike(), empty, received),
    [{ week: '2026-W10', spent: 150, usual: 50 }],
    'weeks of 100, 100, 200 and 200 JOD and four of none make 50 JOD usual',
  );
});

test('a week whose usual spend is 0 is no spike, as when five of the 8 weeks before have no purchases', async () => {
  await using database = await postgresql.database();
  const warehouse = inbox(database.connectionString);
  const empty = await warehouse.receive();
  const received = await warehouse.receive(
    ...weeks('100.000', '100.000', '100.000'),
    ['Arab Bank', purchase('150.000'), '2026-03-04T09:00:00Z'],
  );

  assert.deepEqual(
    await warehouse.evaluate(new SpendSpike(), empty, received),
    [],
    'three weeks of 100 JOD and five of none make 0 JOD usual, which any spend passes twice',
  );
});

test('the usual spend is the median of the 8 weeks before the week, without the week itself', async () => {
  await using database = await postgresql.database();
  const warehouse = inbox(database.connectionString);
  const empty = await warehouse.receive();
  const received = await warehouse.receive(
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
    await warehouse.evaluate(new SpendSpike(), empty, received),
    [{ week: '2026-W10', spent: 500, usual: 200 }],
    'the mean, 287.5 JOD, or a median with the week itself, 300 JOD, would not tell',
  );
});

test('a load that takes a week past twice its usual spend tells the week once, and exactly twice tells nothing', async () => {
  await using database = await postgresql.database();
  const warehouse = inbox(database.connectionString);
  const rule = new SpendSpike();
  const usual = await warehouse.receive(...eightUsualWeeks);
  const twice = await warehouse.receive([
    'Arab Bank',
    purchase('200.000'),
    '2026-03-04T09:00:00Z',
  ]);
  const past = await warehouse.receive([
    'Arab Bank',
    purchase('0.001'),
    '2026-03-04T10:00:00Z',
  ]);
  const more = await warehouse.receive([
    'Arab Bank',
    purchase('50.000'),
    '2026-03-05T09:00:00Z',
  ]);

  assert.deepEqual(
    await warehouse.evaluate(rule, usual, twice),
    [],
    'exactly twice is not past twice',
  );
  assert.deepEqual(await warehouse.evaluate(rule, twice, past), [
    { week: '2026-W10', spent: 200.001, usual: 100 },
  ]);
  assert.deepEqual(
    await warehouse.evaluate(rule, past, more),
    [],
    'a week is told once',
  );
});

test('a purchase just after midnight on Monday in Amman counts in the new ISO week, across the new year', async () => {
  await using database = await postgresql.database();
  const warehouse = inbox(database.connectionString);
  const empty = await warehouse.receive();
  const received = await warehouse.receive(
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
    await warehouse.evaluate(new SpendSpike(), empty, received),
    [{ week: '2025-W01', spent: 210, usual: 100 }],
    'Monday 30 December 2024 starts 2025-W01',
  );
});
