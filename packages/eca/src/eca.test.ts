import assert from 'node:assert/strict';
import { EventEmitter, on } from 'node:events';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLTagStore } from 'node:sqlite';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { type Condition, Eca, type Warehouse } from './index.ts';

type Sms = { guid: string; handle: string; text: string; date: string };

// A Messages import as elt's SQLite destination writes one: a STRICT
// raw_messages table with loaded_at and a reader view over every column.
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

// The warehouse a host gives eca: the import opened read-only, and a commit
// signal the host raises after each elt pass writes to it.
class ImportWarehouse implements Warehouse<SQLTagStore>, Disposable {
  readonly sql: SQLTagStore;
  readonly #database: DatabaseSync;
  readonly #commits = new EventEmitter();

  constructor(path: string) {
    this.#database = new DatabaseSync(path, { readOnly: true });
    this.sql = this.#database.createTagStore();
  }

  commit(): void {
    this.#commits.emit('commit');
  }

  commits(signal: AbortSignal): AsyncIterable<unknown> {
    return on(this.#commits, 'commit', { signal });
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
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
class EarlyMonthSpend implements Condition<SQLTagStore, { spent: number }> {
  evaluate(sql: SQLTagStore) {
    const fils = new Map<string, number>();
    for (const {
      text,
      date,
    } of sql.all`SELECT text, date FROM messages WHERE handle = 'Arab Bank'`) {
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

const october = [
  purchase('a', '2026-10-01T09:00:00.000Z', '174.495'),
  // 2 Oct 00:01:58 in Amman
  purchase('b', '2026-10-01T21:01:58.000Z', '46.312'),
];
const november = [
  purchase('c', '2026-11-02T09:00:00.000Z', '120.000'),
  purchase('d', '2026-11-05T09:00:00.000Z', '85.000'),
];

test('a commit that changes nothing yields nothing, and a new purchase in a month that started yields changed', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-change-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  eca.add({ id: 'early-month-spend', condition: new EarlyMonthSpend() });
  await using changes = eca.watch({ signal: AbortSignal.timeout(10_000) });

  const first = changes.next();
  load(path, october);
  warehouse.commit();
  const started = await first;
  const second = changes.next();
  warehouse.commit();
  // eca evaluates synchronously, so this commit is evaluated once pending
  // callbacks have run, before the next purchase lands.
  await setImmediate();
  load(path, [purchase('e', '2026-10-03T08:00:00.000Z', '10.000')]);
  warehouse.commit();

  assert.deepEqual(
    [started.value, (await second).value],
    [
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
    ],
  );
});

test('a rule added when October already passed 200 stays quiet about October, and a later November crossing still starts', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'eca-baseline-'),
  );
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, october);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });

  eca.add({ id: 'early-month-spend', condition: new EarlyMonthSpend() });
  await using changes = eca.watch({ signal: AbortSignal.timeout(10_000) });
  const first = changes.next();
  load(path, november);
  warehouse.commit();

  assert.deepEqual((await first).value, {
    type: 'started',
    rule: 'early-month-spend',
    key: '2026-11',
    data: { spent: 205 },
  });
});

test('a deleted purchase that takes the total under 200 yields the month ended', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-end-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  eca.add({ id: 'early-month-spend', condition: new EarlyMonthSpend() });
  await using changes = eca.watch({ signal: AbortSignal.timeout(10_000) });

  const first = changes.next();
  load(path, october);
  warehouse.commit();
  const started = await first;
  const second = changes.next();
  remove(path, 'b');
  warehouse.commit();

  assert.deepEqual(
    [started.value, (await second).value],
    [
      {
        type: 'started',
        rule: 'early-month-spend',
        key: '2026-10',
        data: { spent: 220.807 },
      },
      { type: 'ended', rule: 'early-month-spend', key: '2026-10' },
    ],
  );
});

test('a November crossing starts its own month and leaves October alone', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-months-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  eca.add({ id: 'early-month-spend', condition: new EarlyMonthSpend() });
  await using changes = eca.watch({ signal: AbortSignal.timeout(10_000) });

  const first = changes.next();
  load(path, october);
  warehouse.commit();
  const started = await first;
  const second = changes.next();
  load(path, november);
  warehouse.commit();

  assert.deepEqual(
    [started.value, (await second).value],
    [
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
    ],
  );
});

test('two rules over the same purchases each yield their own started', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-rules-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  eca.add({ id: 'spend-alert', condition: new EarlyMonthSpend() });
  eca.add({ id: 'spend-log', condition: new EarlyMonthSpend() });
  await using changes = eca.watch({ signal: AbortSignal.timeout(10_000) });

  const first = changes.next();
  load(path, october);
  warehouse.commit();
  const alert = await first;
  const log = await changes.next();

  assert.deepEqual(
    [alert.value, log.value],
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

test('changes the host stopped before pulling past come again to its next watch, for every rule that had not moved on', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-again-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  eca.add({ id: 'spend-alert', condition: new EarlyMonthSpend() });
  eca.add({ id: 'spend-log', condition: new EarlyMonthSpend() });
  {
    await using changes = eca.watch({ signal: AbortSignal.timeout(10_000) });
    const first = changes.next();
    load(path, october);
    warehouse.commit();
    await first;
  }

  await using changes = eca.watch({ signal: AbortSignal.timeout(10_000) });
  const alert = changes.next();
  warehouse.commit();

  assert.deepEqual(
    [(await alert).value, (await changes.next()).value],
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

test('a rule the host moved past keeps its new matches when the host stops inside the next rule', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-past-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  eca.add({ id: 'spend-alert', condition: new EarlyMonthSpend() });
  eca.add({ id: 'spend-log', condition: new EarlyMonthSpend() });
  {
    await using changes = eca.watch({ signal: AbortSignal.timeout(10_000) });
    const first = changes.next();
    load(path, october);
    warehouse.commit();
    await first;
    await changes.next();
  }

  await using changes = eca.watch({ signal: AbortSignal.timeout(10_000) });
  const again = changes.next();
  warehouse.commit();

  assert.deepEqual((await again).value, {
    type: 'started',
    rule: 'spend-log',
    key: '2026-10',
    data: { spent: 220.807 },
  });
});

// A watch that never ends would hang the run, so this test has its own deadline.
test('aborting the signal ends the watch', { timeout: 5_000 }, async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-abort-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  eca.add({ id: 'early-month-spend', condition: new EarlyMonthSpend() });
  const controller = new AbortController();
  await using changes = eca.watch({ signal: controller.signal });

  const next = changes.next();
  controller.abort();

  await assert.rejects(next, { name: 'AbortError' });
});
