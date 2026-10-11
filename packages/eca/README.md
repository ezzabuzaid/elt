# @workspace/eca

A user wants to know when the data in a warehouse starts to match a condition. For example: "when my card purchases in the first 10 days of a month pass 200 JOD, tell me". An agent writes the condition as code with SQL in it. The host gives eca the warehouse, and it acts on what eca yields. eca evaluates every condition at each commit to the warehouse, and it yields each new match: a key that starts to match. The model is Event–Condition–Action (ECA), from active databases: a commit is the event, and the host does the action.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

The host makes one `Eca` with its warehouse, adds the rules, and watches the new matches:

```ts
import { Eca } from '@workspace/eca';

const eca = new Eca<SQLTagStore, { spent: number }>({ warehouse });
const spend = { condition: new EarlyMonthSpend() };
await eca.add(spend);

for await (const match of eca.watch({ signal }))
  if (match.rule === spend)
    await notify(
      `You spent ${match.data.spent} JOD in the first 10 days of ${match.key}.`,
    );
```

- A rule is the host's own object with a `condition`. Each new match carries it back as `match.rule`, so the host knows which rule matched.
- `add` evaluates the condition one time, for its baseline, and resolves when the baseline is kept. It yields nothing.
- `watch` evaluates every rule at each commit to the warehouse, and it yields each new match.
- The two type parameters are the handle of the warehouse and the data of the matches. Give a union when the rules have different data.

## Give eca the warehouse

eca does not open the warehouse, and it does not know what holds it. The host gives a `Warehouse`: `sql`, the read-only handle that the conditions query, and `commits(signal)`, an async iterable with one item for each commit. This adapter reads one SQLite import of elt, and the host raises a commit after each elt pass:

```ts
import { EventEmitter, on } from 'node:events';
import { DatabaseSync, type SQLTagStore } from 'node:sqlite';

import type { Warehouse } from '@workspace/eca';

class ImportWarehouse implements Warehouse<SQLTagStore> {
  readonly sql: SQLTagStore;
  readonly #commits = new EventEmitter();

  constructor(path: string) {
    this.sql = new DatabaseSync(path, { readOnly: true }).createTagStore();
  }

  commit(): void {
    this.#commits.emit('commit');
  }

  commits(signal: AbortSignal): AsyncIterable<unknown> {
    return on(this.#commits, 'commit', { signal });
  }
}
```

The adapter decides what read-only means and how it learns of a commit. A SQLite adapter can also read `PRAGMA data_version`, and a Postgres adapter can listen with `LISTEN`. See [ADR 0005](./docs/adr/0005-eca-reads-the-warehouse-through-a-port.md).

## Write a condition

A condition has one method: `evaluate(sql)`. It gets the handle of the warehouse, and it resolves to the matches that are true now. It is async, because a warehouse such as Postgres answers a query asynchronously; a condition over a synchronous handle, such as `node:sqlite`, is `async` too. Each match has a key and data:

```ts
import type { SQLTagStore } from 'node:sqlite';

import type { Condition } from '@workspace/eca';

// Card purchases of Arab Bank in days 1 to 10 of each month, on the clock of
// the user, by the time of the SMS.
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
```

- The condition parses its own data. SQL reads the rows, and the code reads the text. See [ADR 0004](./docs/adr/0004-each-condition-parses-its-own-data.md).
- Judge a window by the time in the data, not by the time of the evaluation. A commit can be late.

## New matches

A new match is `{ rule, key, data }`: a key that the condition matches now and did not match in the previous evaluation. The condition chooses the key, and the key sets how often the host hears of a match:

| Key       | The host hears                                  |
| --------- | ----------------------------------------------- |
| the month | one time for each month                         |
| the day   | one time for each day                           |
| one text  | one time, until the condition stops matching it |
| an id     | one time for each id                            |

- A key that keeps matching gives nothing, also when its data changes. More spend in October after the crossing gives nothing.
- A key that stops matching gives nothing. When it matches again later, it is a new match again: October dropped under 200 and passed it again.

See [ADR 0007](./docs/adr/0007-eca-yields-only-new-matches.md).

## Watch the new matches

The host pulls each new match. eca evaluates the next commit only when the host asks for the next new match, so a slow host never gets a pile of evaluations. See [ADR 0003](./docs/adr/0003-the-host-acts-on-each-new-match.md).

- **Move past a new match.** A rule takes its new keys only when the host moved past its last new match: it asked for the next one. A new match that the host stopped at comes again to its next watch, with the later new matches of that rule from that commit.
- **Stop the watch.** Abort the signal. eca gives the signal to `commits`, and `watch` ends the way `commits` ends. With `events.on`, it rejects with an `AbortError`. A `break` out of the loop also stops it, and the new match of that turn was not moved past.

## A new rule starts from a baseline

A rule yields only keys that start to match after it was added. `add` keeps the keys of its first evaluation and yields nothing. A rule added on 15 October, after October passed 200 JOD, never yields October. See [ADR 0002](./docs/adr/0002-a-new-rule-starts-from-a-baseline.md).

The keys are in memory. When the host starts again and adds its rules again, each rule takes a new baseline, and a key that started to match while the host was down is not yielded. Restarts are the concern of the host. See [ADR 0006](./docs/adr/0006-eca-keeps-no-state-across-restarts.md).

## When something fails

- **A condition throws in `add`.** `add` throws, and the rule is not added.
- **A condition throws in `watch`.** `watch` rejects with that error. The rules after it are not evaluated for that commit, and the rule keeps its old keys.
- **`commits` rejects.** `watch` rejects with the same error.
- **The host fails to act on a new match.** Stop the watch before you ask for the next one. The new match comes again at the next commit of a new watch. eca retries nothing.

## What eca does not do

- No time events. A window that closes with no new data ends at the next commit. A rule about data that did not come ("I did not spend 200 JOD by day 10") cannot be written.
- A rule whose window is fixed in time and already over is added, and it never yields.
- No news of a match whose data changed, or of a match that stopped. See [ADR 0007](./docs/adr/0007-eca-yields-only-new-matches.md).
- No state across restarts.
- No routing. Each commit evaluates every rule. See [ADR 0001](./docs/adr/0001-each-commit-evaluates-every-rule.md).

## The same concepts in other systems

| This package                          | Other systems                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Rule: event, condition, action        | ECA rules of active databases (HiPAC, 1988); Home Assistant automations: trigger, condition, action |
| Event: a commit                       | SQL `CREATE TRIGGER … AFTER INSERT`                                                                 |
| Key                                   | PagerDuty Events API `dedup_key`; the labels of a Prometheus alert instance                         |
| New match                             | A Prometheus alert goes from inactive to firing                                                     |
| Baseline                              | A SQL trigger does not fire for older rows; a Kafka consumer group with `auto.offset.reset=latest`  |
| Move past a new match                 | A Kafka consumer commits its offset after it processed a message                                    |
| `watch`, pulled with `for await`      | `Pipeline.watch` of elt; `events.on` of Node                                                        |
| Warehouse port and the host's adapter | Ports and adapters; the `Dialect` of Kysely                                                         |
| A threshold over a period             | AWS Budgets: one alert for each threshold in each budget period                                     |

## Documentation

- [ADR 0001: Each commit evaluates every rule](./docs/adr/0001-each-commit-evaluates-every-rule.md)
- [ADR 0002: A new rule starts from a baseline](./docs/adr/0002-a-new-rule-starts-from-a-baseline.md)
- [ADR 0003: The host acts on each new match](./docs/adr/0003-the-host-acts-on-each-new-match.md)
- [ADR 0004: Each condition parses its own data](./docs/adr/0004-each-condition-parses-its-own-data.md)
- [ADR 0005: eca reads the warehouse through a port](./docs/adr/0005-eca-reads-the-warehouse-through-a-port.md)
- [ADR 0006: eca keeps no state across restarts](./docs/adr/0006-eca-keeps-no-state-across-restarts.md)
- [ADR 0007: eca yields only new matches](./docs/adr/0007-eca-yields-only-new-matches.md)

## Development

Run the commands from the workspace root.

```sh
npx nx run eca:test        # builds, then runs the tests in dist/
npx nx run eca:typecheck   # formats, lints, then type checks
npx nx run eca:build       # compiles src/ to dist/
```

The tests have their own warehouse over a SQLite import that they write as elt writes it.

```
src/
  eca.ts         Eca: add, watch, and the comparison of keys
  rule.ts        Rule, Condition, Match, NewMatch
  warehouse.ts   the Warehouse port
  index.ts       the public exports
  eca.test.ts    the tests
```
