import assert from 'node:assert/strict';
import { EventEmitter, on } from 'node:events';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLTagStore } from 'node:sqlite';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { type Condition, Eca, type Match, type Warehouse } from './index.ts';

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
  async evaluate(sql: SQLTagStore) {
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

// The test condition reads SQLite synchronously, so eca's evaluation of every
// commit raised so far settles once pending callbacks have run.
const evaluated = () => setImmediate();

test('a crossing yields its month once: a commit that changes nothing, or more spend in that month, yields nothing more', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-once-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  const spend = { condition: new EarlyMonthSpend() };
  await eca.add(spend);
  await using matches = eca.watch({ signal: AbortSignal.timeout(10_000) });

  const first = matches.next();
  load(path, october);
  warehouse.commit();
  const crossed = await first;
  const second = matches.next();
  warehouse.commit();
  await evaluated();
  load(path, [purchase('e', '2026-10-03T08:00:00.000Z', '10.000')]);
  warehouse.commit();
  await evaluated();
  load(path, november);
  warehouse.commit();

  assert.deepEqual(
    [crossed.value, (await second).value],
    [
      { rule: spend, key: '2026-10', data: { spent: 220.807 } },
      { rule: spend, key: '2026-11', data: { spent: 205 } },
    ],
  );
});

test('a rule added when October already passed 200 stays quiet about October, and a later November crossing still yields', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'eca-baseline-'),
  );
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, october);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  const spend = { condition: new EarlyMonthSpend() };

  await eca.add(spend);
  await using matches = eca.watch({ signal: AbortSignal.timeout(10_000) });
  const first = matches.next();
  load(path, november);
  warehouse.commit();

  assert.deepEqual((await first).value, {
    rule: spend,
    key: '2026-11',
    data: { spent: 205 },
  });
});

test('a month that drops under 200 and crosses again yields again', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-again-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  const spend = { condition: new EarlyMonthSpend() };
  await eca.add(spend);
  await using matches = eca.watch({ signal: AbortSignal.timeout(10_000) });

  const first = matches.next();
  load(path, october);
  warehouse.commit();
  const crossed = await first;
  const second = matches.next();
  remove(path, 'b');
  warehouse.commit();
  await evaluated();
  load(path, [purchase('f', '2026-10-04T08:00:00.000Z', '30.000')]);
  warehouse.commit();

  assert.deepEqual(
    [crossed.value, (await second).value],
    [
      { rule: spend, key: '2026-10', data: { spent: 220.807 } },
      { rule: spend, key: '2026-10', data: { spent: 204.495 } },
    ],
  );
});

test('two rules over the same purchases each yield their own match', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-rules-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  const alert = { condition: new EarlyMonthSpend() };
  const log = { condition: new EarlyMonthSpend() };
  await eca.add(alert);
  await eca.add(log);
  await using matches = eca.watch({ signal: AbortSignal.timeout(10_000) });

  const first = matches.next();
  load(path, october);
  warehouse.commit();
  const fromAlert = await first;
  const fromLog = await matches.next();

  assert.equal(fromAlert.value?.rule, alert);
  assert.equal(fromLog.value?.rule, log);
});

test('matches the host stopped before pulling past come again to its next watch, for every rule that had not moved on', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-stop-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  const alert = { condition: new EarlyMonthSpend() };
  const log = { condition: new EarlyMonthSpend() };
  await eca.add(alert);
  await eca.add(log);
  {
    await using matches = eca.watch({ signal: AbortSignal.timeout(10_000) });
    const first = matches.next();
    load(path, october);
    warehouse.commit();
    await first;
  }

  await using matches = eca.watch({ signal: AbortSignal.timeout(10_000) });
  const again = matches.next();
  warehouse.commit();

  assert.equal((await again).value?.rule, alert);
  assert.equal((await matches.next()).value?.rule, log);
});

test('a rule the host moved past keeps its new matches when the host stops inside the next rule', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-past-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  const alert = { condition: new EarlyMonthSpend() };
  const log = { condition: new EarlyMonthSpend() };
  await eca.add(alert);
  await eca.add(log);
  {
    await using matches = eca.watch({ signal: AbortSignal.timeout(10_000) });
    const first = matches.next();
    load(path, october);
    warehouse.commit();
    await first;
    await matches.next();
  }

  await using matches = eca.watch({ signal: AbortSignal.timeout(10_000) });
  const again = matches.next();
  warehouse.commit();

  assert.equal((await again).value?.rule, log);
});

test('a rule added while a watch runs stays quiet about what matched before it was added, even when its baseline answers last', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-late-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, october);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  await using matches = eca.watch({ signal: AbortSignal.timeout(10_000) });
  const first = matches.next();
  // The baseline answers only when the test says so, as a slow warehouse might.
  const baseline = Promise.withResolvers<readonly Match<{ spent: number }>[]>();
  let evaluations = 0;
  const spend = {
    condition: {
      evaluate: (sql: SQLTagStore) =>
        evaluations++ === 0
          ? baseline.promise
          : new EarlyMonthSpend().evaluate(sql),
    },
  };

  const adding = eca.add(spend);
  warehouse.commit();
  await evaluated();
  baseline.resolve(await new EarlyMonthSpend().evaluate(warehouse.sql));
  await adding;
  load(path, november);
  warehouse.commit();

  assert.deepEqual((await first).value, {
    rule: spend,
    key: '2026-11',
    data: { spent: 205 },
  });
});

test('a condition that throws yields its failure, the other rules still yield, and the failing rule tries again at the next commit', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-fail-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  // Fails only on its second evaluation, the first commit after its baseline.
  let evaluations = 0;
  const flaky = {
    condition: {
      evaluate: (sql: SQLTagStore) =>
        ++evaluations === 2
          ? Promise.reject(new Error('no such table: messages.mesages'))
          : new EarlyMonthSpend().evaluate(sql),
    },
  };
  const spend = { condition: new EarlyMonthSpend() };
  await eca.add(flaky);
  await eca.add(spend);
  await using matches = eca.watch({ signal: AbortSignal.timeout(10_000) });

  const first = matches.next();
  load(path, october);
  warehouse.commit();
  const failed = await first;
  const crossed = await matches.next();
  const third = matches.next();
  warehouse.commit();
  const retried = await third;

  assert.ok(failed.value !== undefined && 'error' in failed.value);
  assert.equal(failed.value.rule, flaky);
  assert.ok(failed.value.error instanceof Error);
  assert.equal(failed.value.error.message, 'no such table: messages.mesages');
  assert.deepEqual(
    [crossed.value, retried.value],
    [
      { rule: spend, key: '2026-10', data: { spent: 220.807 } },
      { rule: flaky, key: '2026-10', data: { spent: 220.807 } },
    ],
  );
});

test('a failing rule keeps the matches it already reported, so after the failure only what is new yields', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-kept-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  // Fails only on its third evaluation, after it reported October.
  let evaluations = 0;
  const flaky = {
    condition: {
      evaluate: (sql: SQLTagStore) =>
        ++evaluations === 3
          ? Promise.reject(new Error('connection reset'))
          : new EarlyMonthSpend().evaluate(sql),
    },
  };
  await eca.add(flaky);
  await using matches = eca.watch({ signal: AbortSignal.timeout(10_000) });

  const first = matches.next();
  load(path, october);
  warehouse.commit();
  const reported = await first;
  const second = matches.next();
  warehouse.commit();
  const failed = await second;
  const third = matches.next();
  load(path, november);
  warehouse.commit();
  const after = await third;
  // Whatever yields next must be December's crossing, so October was not
  // queued again behind November.
  const fourth = matches.next();
  load(path, [
    purchase('g', '2026-12-02T09:00:00.000Z', '150.000'),
    purchase('h', '2026-12-03T09:00:00.000Z', '60.000'),
  ]);
  warehouse.commit();
  const next = await fourth;

  assert.deepEqual(reported.value, {
    rule: flaky,
    key: '2026-10',
    data: { spent: 220.807 },
  });
  assert.ok(failed.value !== undefined && 'error' in failed.value);
  assert.deepEqual(
    [after.value, next.value],
    [
      { rule: flaky, key: '2026-11', data: { spent: 205 } },
      { rule: flaky, key: '2026-12', data: { spent: 210 } },
    ],
  );
});

test('a rule added again with the keys its host saved yields a key that started to match while the host was down', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-restart-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const spend = { condition: new EarlyMonthSpend() };
  const before = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  await before.add(spend);
  const saved = before.keys(spend);
  // October crosses 200 while the host is down.
  load(path, october);
  const after = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  await after.add(spend, { keys: saved });
  await using matches = after.watch({ signal: AbortSignal.timeout(10_000) });

  const first = matches.next();
  warehouse.commit();

  assert.deepEqual((await first).value, {
    rule: spend,
    key: '2026-10',
    data: { spent: 220.807 },
  });
});

test('a rule added again with the keys its host saved stays quiet about those keys, and still yields a later one', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'eca-restart-quiet-'),
  );
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, october);
  using warehouse = new ImportWarehouse(path);
  const spend = { condition: new EarlyMonthSpend() };
  const before = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  await before.add(spend);
  const saved = before.keys(spend);
  const after = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  await after.add(spend, { keys: saved });
  await using matches = after.watch({ signal: AbortSignal.timeout(10_000) });

  const first = matches.next();
  warehouse.commit();
  await evaluated();
  load(path, november);
  warehouse.commit();

  assert.deepEqual([...saved], ['2026-10']);
  assert.deepEqual((await first).value, {
    rule: spend,
    key: '2026-11',
    data: { spent: 205 },
  });
});

test('the keys a host reads to save hold a new match only once the host moved past it', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-keys-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  const spend = { condition: new EarlyMonthSpend() };
  await eca.add(spend);
  const watching = new AbortController();
  await using matches = eca.watch({ signal: watching.signal });
  const first = matches.next();
  load(path, october);
  warehouse.commit();
  await first;

  const handling = eca.keys(spend);
  const pulled = matches.next();
  await evaluated();
  const movedPast = eca.keys(spend);
  watching.abort();

  await assert.rejects(pulled, { name: 'AbortError' });
  assert.deepEqual([...handling], []);
  assert.deepEqual([...movedPast], ['2026-10']);
});

test('a host that saves the keys before it moved past a new match hears of the match again after a restart', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'eca-keys-again-'),
  );
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const spend = { condition: new EarlyMonthSpend() };
  const before = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  await before.add(spend);
  const watching = new AbortController();
  const matches = before.watch({ signal: watching.signal });
  const first = matches.next();
  load(path, october);
  warehouse.commit();
  await first;
  // The host saves while it still acts on October, then stops.
  const saved = before.keys(spend);
  watching.abort();
  await assert.rejects(matches.next(), { name: 'AbortError' });
  const after = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  await after.add(spend, { keys: saved });
  await using again = after.watch({ signal: AbortSignal.timeout(10_000) });

  const next = again.next();
  warehouse.commit();

  assert.deepEqual((await next).value, {
    rule: spend,
    key: '2026-10',
    data: { spent: 220.807 },
  });
});

test('the keys of a rule that was never added are refused, so a host never saves an empty list in their place', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-unknown-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });

  assert.throws(
    () => eca.keys({ condition: new EarlyMonthSpend() }),
    TypeError,
  );
});

// A watch that never ends would hang the run, so this test has its own deadline.
test('aborting the signal ends the watch', { timeout: 5_000 }, async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'eca-abort-'));
  const path = join(scratch.path, 'messages.sqlite');
  writeImport(path, []);
  using warehouse = new ImportWarehouse(path);
  const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
  await eca.add({ condition: new EarlyMonthSpend() });
  const controller = new AbortController();
  await using matches = eca.watch({ signal: controller.signal });

  const next = matches.next();
  controller.abort();

  await assert.rejects(next, { name: 'AbortError' });
});
