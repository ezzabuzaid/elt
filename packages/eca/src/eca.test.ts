import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLTagStore } from 'node:sqlite';
import { test } from 'node:test';

import { type Action, type Change, type Condition, Eca } from './index.ts';

type Sms = { guid: string; handle: string; text: string; date: string };

// A Messages import as elt's SQLite destination writes one: a STRICT
// raw_messages table with loaded_at and a reader view over every column. eca
// only reads this file, so the test writes it the way elt would.
function writeImport(path: string, messages: readonly Sms[]): void {
  using database = new DatabaseSync(path);
  database.exec(
    `CREATE TABLE "raw_messages" ("guid" TEXT NOT NULL, "handle" TEXT, "text" TEXT, "date" TEXT, "loaded_at" TEXT NOT NULL) STRICT;
     CREATE VIEW "messages" AS SELECT "guid", "handle", "text", "date", "loaded_at" FROM "raw_messages";`,
  );
  load(path, messages);
}

function load(path: string, messages: readonly Sms[]): void {
  using database = new DatabaseSync(path);
  const insert = database.prepare(
    'INSERT INTO raw_messages (guid, handle, text, date, loaded_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const { guid, handle, text, date } of messages)
    insert.run(guid, handle, text, date, new Date().toISOString());
}

// elt deletes a record its source no longer has.
function remove(path: string, guid: string): void {
  using database = new DatabaseSync(path);
  database.prepare('DELETE FROM raw_messages WHERE guid = ?').run(guid);
}

// An Arab Bank card purchase SMS, in the bank's own template.
const purchase = (guid: string, date: string, amount: string): Sms => ({
  guid,
  handle: 'Arab Bank',
  text: `JO\nتم قيد حركة شراء من حسابكم 500*0000 من Careem Food بمبلغ JOD ${amount} بتاريخ 01/10/2026 12:00 .الرصيد 1000.000 دينار اردني.`,
  date,
});

// What an agent would write for "when I spend over 200 in the first 10 days
// of a month": card purchases by the SMS's own date, on the user's clock.
class EarlyMonthSpend implements Condition<{ spent: number }> {
  evaluate(sql: SQLTagStore) {
    const fils = new Map<string, number>();
    for (const {
      text,
      date,
    } of sql.all`SELECT text, date FROM messages.messages WHERE handle = 'Arab Bank'`) {
      if (typeof text !== 'string' || typeof date !== 'string') continue;
      const amount =
        /تم قيد حركة شراء من حسابكم .* بمبلغ JOD (\d+)\.(\d{3}) /u.exec(text);
      if (amount === null) continue;
      const day = Temporal.Instant.from(date).toZonedDateTimeISO('Asia/Amman');
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

class Recorder<Data> implements Action<Data> {
  readonly changes: Change<Data>[] = [];
  run(change: Change<Data>): void {
    this.changes.push(change);
  }
}

test('a condition that writes to an import is refused, and the import keeps its rows', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-write-'));
  const messages = join(scratch.path, 'messages.sqlite');
  writeImport(messages, [purchase('a', '2026-10-01T09:00:00.000Z', '174.495')]);
  using eca = new Eca({
    store: join(scratch.path, 'eca.sqlite'),
    imports: { messages },
  });

  assert.throws(
    () =>
      eca.add({
        id: 'wipe',
        condition: {
          evaluate(sql) {
            const { changes } = sql.run`DELETE FROM messages.raw_messages`;
            return [{ key: 'wiped', data: changes }];
          },
        },
        action: new Recorder(),
      }),
    /readonly database/,
  );

  using database = new DatabaseSync(messages, { readOnly: true });
  assert.deepEqual(
    { ...database.prepare('SELECT count(*) AS rows FROM raw_messages').get() },
    { rows: 1 },
  );
});

test('purchases in days 1–10 that pass 200 run the action once, and an unchanged commit runs nothing', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-start-'));
  const messages = join(scratch.path, 'messages.sqlite');
  writeImport(messages, [purchase('a', '2026-10-01T09:00:00.000Z', '174.495')]);
  using eca = new Eca({
    store: join(scratch.path, 'eca.sqlite'),
    imports: { messages },
  });
  const action = new Recorder<{ spent: number }>();
  eca.add({
    id: 'early-month-spend',
    condition: new EarlyMonthSpend(),
    action,
  });

  // 2 Oct 00:01:58 in Amman
  load(messages, [purchase('b', '2026-10-01T21:01:58.000Z', '46.312')]);
  await eca.committed('messages', ['raw_messages']);
  await eca.committed('messages', ['raw_messages']);

  assert.deepEqual(action.changes, [
    {
      type: 'started',
      rule: 'early-month-spend',
      key: '2026-10',
      data: { spent: 220.807 },
    },
  ]);
});

test('a rule added when October already passed 200 stays quiet about October, and a later November crossing still starts', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'eca-baseline-'),
  );
  const messages = join(scratch.path, 'messages.sqlite');
  writeImport(messages, [
    purchase('a', '2026-10-01T09:00:00.000Z', '174.495'),
    purchase('b', '2026-10-01T21:01:58.000Z', '46.312'),
  ]);
  using eca = new Eca({
    store: join(scratch.path, 'eca.sqlite'),
    imports: { messages },
  });
  const action = new Recorder<{ spent: number }>();

  eca.add({
    id: 'early-month-spend',
    condition: new EarlyMonthSpend(),
    action,
  });
  load(messages, [
    purchase('c', '2026-11-02T09:00:00.000Z', '120.000'),
    purchase('d', '2026-11-05T09:00:00.000Z', '85.000'),
  ]);
  await eca.committed('messages', ['raw_messages']);

  assert.deepEqual(action.changes, [
    {
      type: 'started',
      rule: 'early-month-spend',
      key: '2026-11',
      data: { spent: 205 },
    },
  ]);
});

test('a new purchase for a month that already started reports changed with the new total', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-change-'));
  const messages = join(scratch.path, 'messages.sqlite');
  writeImport(messages, []);
  using eca = new Eca({
    store: join(scratch.path, 'eca.sqlite'),
    imports: { messages },
  });
  const action = new Recorder<{ spent: number }>();
  eca.add({
    id: 'early-month-spend',
    condition: new EarlyMonthSpend(),
    action,
  });

  load(messages, [
    purchase('a', '2026-10-01T09:00:00.000Z', '174.495'),
    purchase('b', '2026-10-01T21:01:58.000Z', '46.312'),
  ]);
  await eca.committed('messages', ['raw_messages']);
  load(messages, [purchase('c', '2026-10-03T08:00:00.000Z', '10.000')]);
  await eca.committed('messages', ['raw_messages']);

  assert.deepEqual(action.changes, [
    {
      type: 'started',
      rule: 'early-month-spend',
      key: '2026-10',
      data: { spent: 220.807 },
    },
    {
      type: 'changed',
      rule: 'early-month-spend',
      key: '2026-10',
      data: { spent: 230.807 },
    },
  ]);
});

test('a deleted purchase that takes the total under 200 reports the month ended', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-end-'));
  const messages = join(scratch.path, 'messages.sqlite');
  writeImport(messages, []);
  using eca = new Eca({
    store: join(scratch.path, 'eca.sqlite'),
    imports: { messages },
  });
  const action = new Recorder<{ spent: number }>();
  eca.add({
    id: 'early-month-spend',
    condition: new EarlyMonthSpend(),
    action,
  });

  load(messages, [
    purchase('a', '2026-10-01T09:00:00.000Z', '174.495'),
    purchase('b', '2026-10-01T21:01:58.000Z', '46.312'),
  ]);
  await eca.committed('messages', ['raw_messages']);
  remove(messages, 'b');
  await eca.committed('messages', ['raw_messages']);

  assert.deepEqual(action.changes, [
    {
      type: 'started',
      rule: 'early-month-spend',
      key: '2026-10',
      data: { spent: 220.807 },
    },
    { type: 'ended', rule: 'early-month-spend', key: '2026-10' },
  ]);
});

test('a commit to a table the condition never read leaves the rule alone, and a commit to the table behind its view starts it', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-route-'));
  const messages = join(scratch.path, 'messages.sqlite');
  const slack = join(scratch.path, 'slack.sqlite');
  writeImport(messages, []);
  writeImport(slack, []);
  using eca = new Eca({
    store: join(scratch.path, 'eca.sqlite'),
    imports: { messages, slack },
  });
  const action = new Recorder<{ spent: number }>();
  eca.add({
    id: 'early-month-spend',
    condition: new EarlyMonthSpend(),
    action,
  });
  load(messages, [
    purchase('a', '2026-10-01T09:00:00.000Z', '174.495'),
    purchase('b', '2026-10-01T21:01:58.000Z', '46.312'),
  ]);

  await eca.committed('slack', ['raw_messages']);
  await eca.committed('messages', ['raw_chats']);
  const before = [...action.changes];
  await eca.committed('messages', ['raw_messages']);

  assert.deepEqual(before, []);
  assert.deepEqual(action.changes, [
    {
      type: 'started',
      rule: 'early-month-spend',
      key: '2026-10',
      data: { spent: 220.807 },
    },
  ]);
});

test('after a restart, a crossing imported while the host was down starts, and a month that started before does not start again', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-restart-'));
  const messages = join(scratch.path, 'messages.sqlite');
  const store = join(scratch.path, 'eca.sqlite');
  writeImport(messages, []);
  const action = new Recorder<{ spent: number }>();
  {
    using eca = new Eca({ store, imports: { messages } });
    eca.add({
      id: 'early-month-spend',
      condition: new EarlyMonthSpend(),
      action,
    });
    load(messages, [
      purchase('a', '2026-10-01T09:00:00.000Z', '174.495'),
      purchase('b', '2026-10-01T21:01:58.000Z', '46.312'),
    ]);
    await eca.committed('messages', ['raw_messages']);
  }

  load(messages, [
    purchase('c', '2026-11-02T09:00:00.000Z', '120.000'),
    purchase('d', '2026-11-05T09:00:00.000Z', '85.000'),
  ]);
  using eca = new Eca({ store, imports: { messages } });
  eca.add({
    id: 'early-month-spend',
    condition: new EarlyMonthSpend(),
    action,
  });
  await eca.committed('messages', ['raw_messages']);

  assert.deepEqual(action.changes, [
    {
      type: 'started',
      rule: 'early-month-spend',
      key: '2026-10',
      data: { spent: 220.807 },
    },
    {
      type: 'started',
      rule: 'early-month-spend',
      key: '2026-11',
      data: { spent: 205 },
    },
  ]);
});

test('a November crossing starts its own month and leaves October alone', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-months-'));
  const messages = join(scratch.path, 'messages.sqlite');
  writeImport(messages, []);
  using eca = new Eca({
    store: join(scratch.path, 'eca.sqlite'),
    imports: { messages },
  });
  const action = new Recorder<{ spent: number }>();
  eca.add({
    id: 'early-month-spend',
    condition: new EarlyMonthSpend(),
    action,
  });

  load(messages, [
    purchase('a', '2026-10-01T09:00:00.000Z', '174.495'),
    purchase('b', '2026-10-01T21:01:58.000Z', '46.312'),
  ]);
  await eca.committed('messages', ['raw_messages']);
  load(messages, [
    purchase('c', '2026-11-02T09:00:00.000Z', '120.000'),
    purchase('d', '2026-11-05T09:00:00.000Z', '85.000'),
  ]);
  await eca.committed('messages', ['raw_messages']);

  assert.deepEqual(action.changes, [
    {
      type: 'started',
      rule: 'early-month-spend',
      key: '2026-10',
      data: { spent: 220.807 },
    },
    {
      type: 'started',
      rule: 'early-month-spend',
      key: '2026-11',
      data: { spent: 205 },
    },
  ]);
});

test('two rules over the same purchases each start their own match', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-rules-'));
  const messages = join(scratch.path, 'messages.sqlite');
  writeImport(messages, []);
  using eca = new Eca({
    store: join(scratch.path, 'eca.sqlite'),
    imports: { messages },
  });
  const alert = new Recorder<{ spent: number }>();
  const log = new Recorder<{ spent: number }>();
  eca.add({
    id: 'spend-alert',
    condition: new EarlyMonthSpend(),
    action: alert,
  });
  eca.add({ id: 'spend-log', condition: new EarlyMonthSpend(), action: log });

  load(messages, [
    purchase('a', '2026-10-01T09:00:00.000Z', '174.495'),
    purchase('b', '2026-10-01T21:01:58.000Z', '46.312'),
  ]);
  await eca.committed('messages', ['raw_messages']);

  assert.deepEqual(
    [...alert.changes, ...log.changes],
    [
      {
        type: 'started',
        rule: 'spend-alert',
        key: '2026-10',
        data: { spent: 220.807 },
      },
      {
        type: 'started',
        rule: 'spend-log',
        key: '2026-10',
        data: { spent: 220.807 },
      },
    ],
  );
});

test("a condition that reads only Slack wakes on Slack's commit, not on the Messages table of the same name", async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-slack-'));
  const messages = join(scratch.path, 'messages.sqlite');
  const slack = join(scratch.path, 'slack.sqlite');
  writeImport(messages, []);
  writeImport(slack, []);
  using eca = new Eca({
    store: join(scratch.path, 'eca.sqlite'),
    imports: { messages, slack },
  });
  const action = new Recorder<{ count: number }>();
  eca.add({
    id: 'slack-messages',
    condition: {
      evaluate(sql) {
        const row = sql.get`SELECT count(*) AS count FROM slack.messages`;
        return typeof row?.count === 'number' && row.count > 0
          ? [{ key: 'any', data: { count: row.count } }]
          : [];
      },
    },
    action,
  });
  load(slack, [
    {
      guid: 's1',
      handle: 'U1',
      text: 'hello',
      date: '2026-10-01T09:00:00.000Z',
    },
  ]);

  await eca.committed('messages', ['raw_messages']);
  const before = [...action.changes];
  await eca.committed('slack', ['raw_messages']);

  assert.deepEqual(before, []);
  assert.deepEqual(action.changes, [
    { type: 'started', rule: 'slack-messages', key: 'any', data: { count: 1 } },
  ]);
});
