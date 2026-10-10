# @workspace/eca

A user wants an action when the data in an import starts to match a condition. For example: "when my card purchases in the first 10 days of a month pass 200 JOD, tell me". eca is the layer for these rules. An agent writes the condition as code with SQL in it. The host keeps the SQLite imports of elt current and tells eca about each commit. eca evaluates the conditions that read the committed tables, and it gives each change to the action of the user. The model is Event–Condition–Action (ECA), from active databases.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

The host makes one `Eca`. It gives a store, and a name and a path for each import:

```ts
import { Eca } from '@workspace/eca';

using eca = new Eca({
  store: '/path/to/eca.sqlite',
  imports: { messages: '/path/to/messages/data.sqlite' },
});

eca.add({
  id: 'early-month-spend',
  condition: new EarlyMonthSpend(),
  action: notify,
});

// After each commit of elt, tell eca which tables of which import it wrote:
await eca.committed('messages', ['raw_messages']);
```

- `add` evaluates the condition of a new rule one time, for its baseline. It calls no action.
- `committed` evaluates each rule whose condition read one of the tables, and calls its action with each change.
- Dispose the `Eca` to close the store and the imports.

## Write a condition

A condition has one method: `evaluate(sql)`. `sql` is a tag store of `node:sqlite` over the imports. A condition reads a table by the name of its import, for example `messages.messages`. It returns the matches that are true now. Each match has a key and data:

```ts
import type { SQLTagStore } from 'node:sqlite';

import type { Condition } from '@workspace/eca';

// Card purchases of Arab Bank in days 1 to 10 of each month, on the clock of
// the user, by the time of the SMS.
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
```

- The condition parses its own data. SQL reads the rows, and the code reads the text. See [ADR 0004](./docs/adr/0004-each-condition-parses-its-own-data.md).
- Judge a window by the time in the data, not by the time of the evaluation. An import can be late.
- The imports are read-only. A condition that writes throws `attempt to write a readonly database`.
- eca compares the data as JSON. Give data that `JSON.stringify` can write, with its properties in the same order each time.

## The key

The condition chooses the key, and the key sets how often the action hears of a match. With the month as the key, the action hears one time for each month:

| Key       | The action hears             |
| --------- | ---------------------------- |
| the month | one time for each month      |
| the day   | one time for each day        |
| one text  | one time, until the key ends |
| an id     | one time for each id         |

## Changes

eca compares each evaluation with the previous one, key by key. It gives the action one change for each difference:

| Change                                 | When                                          |
| -------------------------------------- | --------------------------------------------- |
| `{ type: 'started', rule, key, data }` | The key is new.                               |
| `{ type: 'changed', rule, key, data }` | The key was there, and its data is different. |
| `{ type: 'ended', rule, key }`         | The key is not there now.                     |

A key with the same data gives no change. An ended change has no data.

```ts
import type { Action } from '@workspace/eca';

const notify: Action<{ spent: number }> = {
  run(change) {
    if (change.type === 'started')
      console.log(
        `You spent ${change.data.spent} JOD in the first 10 days of ${change.key}.`,
      );
  },
};
```

## Events come from the tables a condition read

A rule does not name its event. SQLite tells eca each table that a condition reads, also through a view, when it prepares the statement. The condition above reads the view `messages`, so its read is the table `raw_messages` in the import `messages`. A commit of `raw_messages` in another import, for example `slack`, does not wake it. eca records the reads again in each evaluation. See [ADR 0001](./docs/adr/0001-a-rule-wakes-on-commits-to-the-tables-its-condition-read.md).

The host reports the tables that elt writes (`raw_<stream>`), not the views.

## A new rule starts from a baseline

A rule acts only on commits after it was added. When the store does not know the id of a rule, `add` keeps the matches of its first evaluation and calls no action. A rule added on 15 October, after October passed 200 JOD, never acts for October. See [ADR 0002](./docs/adr/0002-a-new-rule-starts-from-a-baseline.md).

The store keeps the matches and the reads of each rule across restarts. When the host adds a rule again with the same id, eca takes no new baseline. A commit that came while the host was down still starts its key. The store is disposable: a store of another layout starts empty.

## When something fails

- **A condition throws in its baseline.** `add` throws, and the rule is not added.
- **A condition throws in `committed`.** `committed` rejects. The rules after it are not evaluated for that commit, and the store keeps the old matches of the rule.
- **An action throws.** `committed` rejects, and the store keeps the old matches of the rule. The next commit gives the same changes again, also those that the action already accepted. An action must accept a change that it saw before. See [ADR 0003](./docs/adr/0003-the-host-makes-action-delivery-safe.md).

## What eca does not do

- No time events. A window that closes with no new data ends at the next commit. A rule about data that did not come ("I did not spend 200 JOD by day 10") cannot be written.
- A rule whose window is fixed in time and already over is added, and it never acts.
- eca does not retry an action before the next commit, and it has no outbox. The host makes delivery safe.
- eca reads SQLite imports only.

## The same concepts in other systems

| This package                   | Other systems                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Rule: event, condition, action | ECA rules of active databases (HiPAC, 1988); Home Assistant automations: trigger, condition, action                                   |
| Event: a commit to a table     | SQL `CREATE TRIGGER … AFTER INSERT ON raw_messages`                                                                                   |
| Reads found from the SQL       | Dependency tracking: a spreadsheet recalculates a cell when a cell that it uses changes; MobX tracks the observables a reaction reads |
| Key                            | PagerDuty Events API `dedup_key`; the labels of a Prometheus alert instance                                                           |
| Started and ended              | A Prometheus alert goes from inactive to firing; Alertmanager sends resolved                                                          |
| Baseline                       | A SQL trigger does not fire for older rows; a Kafka consumer group with `auto.offset.reset=latest`                                    |
| A threshold over a period      | AWS Budgets: one alert for each threshold in each budget period                                                                       |

## Documentation

- [ADR 0001: A rule wakes on commits to the tables its condition read](./docs/adr/0001-a-rule-wakes-on-commits-to-the-tables-its-condition-read.md)
- [ADR 0002: A new rule starts from a baseline](./docs/adr/0002-a-new-rule-starts-from-a-baseline.md)
- [ADR 0003: The host makes action delivery safe](./docs/adr/0003-the-host-makes-action-delivery-safe.md)
- [ADR 0004: Each condition parses its own data](./docs/adr/0004-each-condition-parses-its-own-data.md)

## Development

Run the commands from the workspace root.

```sh
npx nx run eca:test        # builds, then runs the tests in dist/
npx nx run eca:typecheck   # formats, lints, then type checks
npx nx run eca:build       # compiles src/ to dist/
```

The tests write their own imports in a temporary directory, as elt writes them.

```
src/
  eca.ts        Eca: add, committed, and the comparison of evaluations
  imports.ts    the imports, read-only, and the reads of each evaluation
  store.ts      the matches and the reads of each rule, across restarts
  rule.ts       Rule, Condition, Match, Action, Change
  index.ts      the public exports
  eca.test.ts   the tests
```
