# @eltjs/eca

A user wants to know when the data in a warehouse starts to match a condition. For example: "when my card purchases in the first 10 days of a month pass 200 JOD, tell me". An agent writes the condition as code with SQL in it. A condition reads the warehouse at two positions, before and after, and it gives what became true between them. The host keeps one cursor for each rule, gives it to each evaluation, and saves the cursor that it gets back with the matches. eca keeps nothing. The model is Event–Condition–Action (ECA), from active databases: a new position of the warehouse is the event, and the host does the action.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

The host makes one `Eca` with its warehouse and a clock. It starts each new rule, and then evaluates its rules when it wants:

```ts
import { Eca } from '@eltjs/eca';

const eca = new Eca<DatabaseSync, { month: string; spent: number }>({
  warehouse,
  clock: globalThis,
});
const spend = { condition: new EarlyMonthSpend() };
cursors.set(spend, await eca.start());

for await (const outcome of eca.evaluate(
  [...cursors].map(([rule, cursor]) => ({ rule, cursor })),
)) {
  if ('expired' in outcome) continue; // the host decides; see below
  await transaction(async (tx) => {
    for (const { month, spent } of outcome.matches)
      await outbox(
        tx,
        `You spent ${spent} JOD in the first 10 days of ${month}.`,
      );
    await saveCursor(tx, outcome.rule, outcome.cursor);
  });
}
```

- A rule is the host's own object with a `condition`. Each outcome carries it back as `outcome.rule`, with the host's own type, so a rule can hold what the host needs, such as the name its cursor is saved under.
- `start()` gives the cursor of a new rule: the newest position of the warehouse, now. The rule matches only what becomes true after it.
- `evaluate(rules)` gives one outcome for each rule, in order. The host saves its matches and its cursor in one transaction of its own, so a stop between them loses no match and repeats none.
- The two type parameters are the handle of the warehouse and the data of a match. Give a union when the rules have different data.
- The host decides when to evaluate: after each pass, on a timer, or when a user asks. See [ADR 0001](./docs/adr/0001-the-host-decides-when-a-rule-is-evaluated.md).

## Give eca the warehouse

eca does not open the warehouse, and it does not know what holds it. The host gives a `Warehouse` with two methods:

- `stable(after)` gives the positions after a position, in ascending order, or `{ expired }`. A position names a commit where no pass is half done.
- `read(position?)` gives a reading of the warehouse as of a position, or as of its newest one: `{ sql, position, at }`, which eca disposes, or `{ expired }`.

elt's SQLite and Postgres destinations give both. The adapter is two lines:

```ts
import type { DatabaseSync } from 'node:sqlite';

import type { Warehouse } from '@eltjs/eca';

const warehouse: Warehouse<DatabaseSync> = {
  stable: async (after) => destination.positions(after),
  read: async (position) => destination.reading(position),
};
```

A Postgres destination gives a `postgres.Sql` reading, whose reader views read the database as of the position. See [ADR 0005](./docs/adr/0005-eca-reads-the-warehouse-through-a-port.md).

## Write a condition

A condition has one method: `evaluate(before, after)`. Each argument is a reading: `sql`, the handle of the warehouse as of a position, and `at`, the time that the reading stands for. It resolves to what matches in `after` that did not match in `before`:

```ts
import type { DatabaseSync } from 'node:sqlite';

import type { Condition, Reading } from '@eltjs/eca';

// The months whose card purchases of Arab Bank in days 1 to 10 pass 200 JOD,
// on the clock of the user, by the time of the SMS, in fils.
function overLimit(sql: DatabaseSync): Map<string, number> {
  const fils = new Map<string, number>();
  for (const { text, date } of sql
    .prepare(`SELECT text, date FROM messages WHERE handle = 'Arab Bank'`)
    .all()) {
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
  return new Map([...fils].filter(([, spent]) => spent > 200_000));
}

class EarlyMonthSpend implements Condition<
  DatabaseSync,
  { month: string; spent: number }
> {
  async evaluate(before: Reading<DatabaseSync>, after: Reading<DatabaseSync>) {
    const was = overLimit(before.sql);
    return [...overLimit(after.sql)]
      .filter(([month]) => !was.has(month))
      .map(([month, spent]) => ({ month, spent: spent / 1000 }));
  }
}
```

- The pattern is "true after, and not true before". What to compare is the condition's own choice: here a month, or an id, a day, or one text.
- The condition parses its own data. SQL reads the rows, and the code reads the text. See [ADR 0004](./docs/adr/0004-each-condition-parses-its-own-data.md).
- A condition on time reads `before.at` and `after.at`: a deadline that passes is one with `before.at < due <= after.at`. Each evaluation starts at the `at` where the last one ended, so it matches once.
- Judge a window by the time in the data, not by the time of the evaluation. A commit can be late.

## The walk

`evaluate` walks each rule from its cursor over each position after it. In each step, one thing moves between `before` and `after`:

1. Time moves up to the commit of the next position, with the data as it was.
2. The data moves to the next position, at that time.
3. After the last position, time moves up to now.

Thus:

- A key that stops matching and matches again between two evaluations matches again. A rule that the host evaluates once a day hears of each crossing of the day.
- A deadline that passes while a task is open matches, also when a later position closed the task, because it is read with the data of that time.
- A step in which nothing moves is skipped. With no new position, the walk is one step: time, from the cursor up to now.
- At most two readings are open at once.

See [ADR 0010](./docs/adr/0010-eca-is-a-stateless-reader-over-warehouse-positions.md).

## Outcomes

| Outcome                            | When                                                   | The cursor                  |
| ---------------------------------- | ------------------------------------------------------ | --------------------------- |
| `{ rule, matches, cursor }`        | The walk ended                                         | At the newest position, now |
| `{ rule, matches, error, cursor }` | The condition threw at a step                          | After the last good step    |
| `{ rule, expired }`                | The warehouse can no longer read the cursor's position | None                        |

- A failure keeps the matches of the steps before it. The next evaluation goes on from the last good step, so a failure that passes, such as a lock, loses nothing. The other rules of the call still run. See [ADR 0008](./docs/adr/0008-a-failing-condition-is-yielded-with-the-matches-before-it.md).
- A position expires when it is older than the retention of the warehouse, or when a fresh run made the warehouse again. The reason says which. The host decides what to do: start the rule again with `start()`, or tell the user. eca never skips it silently.
- A cursor that eca did not make is a `TypeError`. A warehouse with no position yet makes `start()` throw: load it first.

## Remove, pause and resume a rule

eca keeps nothing, so these need no API:

- **Remove** a rule: stop giving its cursor, and delete it.
- **Pause** a rule: keep its cursor, and do not give it.
- **Resume** a rule: give its cursor again. The walk covers each position that it missed, within the retention of the warehouse.

## What eca does not do

- No store. The host saves the cursor of each rule, with its matches.
- No schedule. The host evaluates when it wants; a condition on time matches when the host evaluates after the time passed.
- No news of a match whose data changed, or of a match that stopped, unless the condition asks for it. "True after and not before" is the condition's own choice.
- No routing. Each evaluation evaluates the rules that the host gives. A condition can read the whole warehouse.

## The same concepts in other systems

| This package                          | Other systems                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Rule: event, condition, action        | ECA rules of active databases (HiPAC, 1988); Home Assistant automations: trigger, condition, action                |
| Position, `stable(after)`             | SQL Server change tracking: `CHANGE_TRACKING_CURRENT_VERSION`, `CHANGETABLE(… @since)`; Kafka's last stable offset |
| Reading as of a position              | SQL:2011 system-versioned tables, `FOR SYSTEM_TIME AS OF`                                                          |
| Expired position                      | `CHANGE_TRACKING_MIN_VALID_VERSION`; a Kafka offset older than the log's retention                                 |
| Cursor that the host saves            | A Kafka consumer's committed offset, saved with its output in one transaction                                      |
| Matches and cursor in one transaction | The transactional outbox                                                                                           |
| Warehouse port and the host's adapter | Ports and adapters; the `Dialect` of Kysely                                                                        |

## Documentation

- [ADR 0001: The host decides when a rule is evaluated](./docs/adr/0001-the-host-decides-when-a-rule-is-evaluated.md)
- [ADR 0002: A new rule starts from a baseline](./docs/adr/0002-a-new-rule-starts-from-a-baseline.md) (superseded)
- [ADR 0003: The host acts on each outcome](./docs/adr/0003-the-host-acts-on-each-outcome.md)
- [ADR 0004: Each condition parses its own data](./docs/adr/0004-each-condition-parses-its-own-data.md)
- [ADR 0005: eca reads the warehouse through a port](./docs/adr/0005-eca-reads-the-warehouse-through-a-port.md)
- [ADR 0006: eca keeps no state across restarts](./docs/adr/0006-eca-keeps-no-state-across-restarts.md) (superseded)
- [ADR 0007: eca yields only new matches](./docs/adr/0007-eca-yields-only-new-matches.md) (superseded)
- [ADR 0008: A failing condition is yielded with the matches before it](./docs/adr/0008-a-failing-condition-is-yielded-with-the-matches-before-it.md)
- [ADR 0009: A host gives a rule back its keys](./docs/adr/0009-a-host-gives-a-rule-back-its-keys.md) (superseded)
- [ADR 0010: eca is a stateless reader over warehouse positions](./docs/adr/0010-eca-is-a-stateless-reader-over-warehouse-positions.md)

## Development

Run the commands from the workspace root.

```sh
npx nx run eca:test        # builds, then runs the tests
npx nx run eca:typecheck   # formats, lints, then type checks
npx nx run eca:build       # compiles src/ to dist/
```

The tests run a real elt `Pipeline` into a real SQLite destination, and read it through the destination's positions and readings.

```
src/
  eca.ts         Eca: start, evaluate, and the walk
  rule.ts        Rule, Condition, Outcome
  warehouse.ts   the Warehouse port and Reading
  index.ts       the public exports
  eca.test.ts    the tests
```
