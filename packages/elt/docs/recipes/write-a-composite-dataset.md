# Recipe: Write a composite dataset whose members refresh in order

**Use case.** Sometimes many derived datasets make one result, and each one reads the one before it. For example, the `Vectorizer` of [`@eltjs/vectorizer`](../../../vectorizer/README.md) makes the chunks, the keyword index, the passages and the vectors of a table (#5401). A host that declares each of them by hand must give their names and their order again. A mistake in the order is silent: a dataset reads a relation that is not in step. A `CompositeDataset` is one declaration that gives these datasets, its members, in the order they refresh in. The pipeline refreshes the members in order, and a composite fails as one dataset. See [ADR 0034](../adr/0034-a-composite-dataset-refreshes-its-members-in-order-as-one-dataset.md).

**What you need.** A class that extends `CompositeDataset` of `@eltjs/elt`, and the derived datasets of a destination, such as `View` and `ComputedDataset` of `@eltjs/elt-sqlite`. This program loads its rows through an `IterableSource` into one SQLite file. It needs no server and no network.

## The steps

1. Write a class that extends `CompositeDataset<Target>`. Give it a `name`, which a failure gives.
2. Give it `members`: one or more derived datasets, in the order they refresh in. A member reads only the members before it.
3. Optional: override `validate(connections)` to refuse, with no I/O, a declaration that the copies of the pipeline cannot feed.
4. Give the composite to the pipeline in `derived`. A dataset after the composite can read each of its members.
5. Read `derived_status`. Each member has its own row.

## The program

The composite `order_report` has three members. The view `paid_orders` reads the copy `orders`. The view `customer_totals` reads `paid_orders`. The computed dataset `customer_labels` reads `customer_totals`. The host view `top_customer` comes after the composite and reads `customer_totals`. The first run declares `customer_totals` with a column that `paid_orders` does not have. The second run declares it correctly, in the same file.

```ts title="write-a-composite-dataset.ts"
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { TemporaryFiles } from '@zukhruf/fs';

import {
  CompositeDataset,
  Connection,
  Copy,
  type DerivedDataset,
  DerivedDatasetError,
  IterableSource,
  type LoadedRow,
  Pipeline,
  Rule,
  type RuleResult,
  type RuleValues,
} from '@eltjs/elt';
import {
  ComputedDataset,
  SQLiteDestination,
  SQLiteSyncHistory,
  type SQLiteTable,
  View,
} from '@eltjs/elt-sqlite';

// The orders that the host holds.
const source = new IterableSource({
  identity: 'shop',
  streams: {
    orders: {
      description: 'Each order of the shop.',
      jsonSchema: {
        type: 'object',
        description: 'An order.',
        properties: {
          id: { type: 'string', description: 'Order id.' },
          customer: { type: 'string', description: 'Who ordered.' },
          cents: { type: 'integer', description: 'Price in cents.' },
          paid: { type: 'boolean', description: 'The customer paid.' },
        },
        required: ['id', 'customer', 'cents', 'paid'],
      },
      primaryKey: ['id'],
      deletions: 'closed-world',
      snapshot: () => [
        { id: 'o1', customer: 'anna', cents: 1250, paid: true },
        { id: 'o2', customer: 'anna', cents: 800, paid: true },
        { id: 'o3', customer: 'omar', cents: 3000, paid: true },
        { id: 'o4', customer: 'omar', cents: 500, paid: false },
      ],
    },
  },
});

const label = {
  label: { type: 'text', description: 'What the customer paid.' },
} as const;

// A rule that computes one line for each customer.
class Label extends Rule<LoadedRow, typeof label> {
  override readonly key = { name: 'customer', description: 'The customer.' };
  override readonly output = label;
  override readonly batch = 10;
  override readonly concurrency = 1;

  override read(row: LoadedRow) {
    return typeof row.customer === 'string'
      ? { key: row.customer, input: row }
      : null;
  }

  override async identity() {
    return 'label-1';
  }

  override async compute(
    rows: readonly LoadedRow[],
  ): Promise<readonly RuleResult<RuleValues<typeof label>>[]> {
    return rows.map((row) => ({
      value: {
        label: `${String(row.customer)} paid ${Number(row.cents) / 100} in ${String(row.orders)} orders`,
      },
    }));
  }
}

// One declaration that makes the report of the paid orders. Each member reads
// the member before it.
class OrderReport extends CompositeDataset<SQLiteTable> {
  readonly name = 'order_report';
  readonly members: readonly [
    DerivedDataset<SQLiteTable>,
    ...DerivedDataset<SQLiteTable>[],
  ];

  constructor(into: SQLiteDestination, total: string) {
    super();
    const paid = new View({
      into,
      name: 'paid_orders',
      description: 'Each order that the customer paid.',
      columns: {
        id: 'Order id.',
        customer: 'Who ordered.',
        cents: 'Price in cents.',
      },
      sql: 'SELECT id, customer, cents FROM orders WHERE paid = 1',
    });
    const totals = new View({
      into,
      name: 'customer_totals',
      description: 'What each customer paid.',
      columns: {
        customer: 'The customer.',
        cents: 'Paid cents.',
        orders: 'Paid orders.',
      },
      sql: `SELECT customer, sum(${total}) AS cents, count(*) AS orders FROM paid_orders GROUP BY customer`,
    });
    const labels = new ComputedDataset({
      into,
      name: 'customer_labels',
      description: 'One line for each customer.',
      from: [totals],
      compute: new Label(),
    });
    this.members = [paid, totals, labels];
  }
}

await using folder = await new TemporaryFiles().directory('elt-composite-');
const path = join(folder.path, 'shop.sqlite');
const sqlite = new SQLiteDestination({ path });

// total is the column that customer_totals adds up.
const pipeline = (total: string) =>
  new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'shop',
        source,
        destination: sqlite,
        steps: [
          new Copy(source.streams.orders, sqlite.table('orders'), {
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite_dedup',
          }),
        ],
      }),
    ],
    derived: [
      new OrderReport(sqlite, total),
      // A host view after the composite reads one of its members.
      new View({
        into: sqlite,
        name: 'top_customer',
        description: 'The customer who paid the most.',
        columns: { customer: 'The customer.' },
        sql: 'SELECT customer FROM customer_totals ORDER BY cents DESC LIMIT 1',
      }),
    ],
  });

const read = (sql: string) => {
  using database = new DatabaseSync(path, { readOnly: true });
  return database
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
};
const status = () =>
  read(
    'SELECT dataset, kind, state, error FROM derived_status ORDER BY dataset',
  );

// First run: customer_totals adds up a column that paid_orders does not have.
const first = pipeline('amount');
console.log(
  'derived',
  first.derived.map((dataset) => dataset.name),
);
try {
  await first.run();
} catch (error) {
  if (!(error instanceof DerivedDatasetError)) throw error;
  const { cause } = error;
  if (!(cause instanceof DerivedDatasetError)) throw error;
  console.log('failed', error.dataset, 'member', cause.dataset);
  console.log(error.message);
}
console.log('status', status());

// Second run: the fixed declaration tries the composite again from its first
// member.
await pipeline('cents').run();
console.log('status', status());
console.log(
  'labels',
  read('SELECT customer, label FROM customer_labels ORDER BY customer'),
);
console.log('top', read('SELECT customer FROM top_customer'));
```

Build `elt` and `elt-sqlite` with `npx nx build elt` and `npx nx build elt-sqlite`. Copy the program into a temporary file in `packages/elt`, run it with Node.js 26, and delete the file:

```sh
node write-a-composite-dataset.ts
```

Output:

```
derived [ 'paid_orders', 'customer_totals', 'customer_labels', 'top_customer' ]
failed order_report member customer_totals
Derived dataset order_report failed: Derived dataset customer_totals failed: no such column: amount
status [
  {
    dataset: 'customer_totals',
    kind: 'view',
    state: 'failed',
    error: 'no such column: amount'
  },
  {
    dataset: 'paid_orders',
    kind: 'view',
    state: 'current',
    error: null
  },
  {
    dataset: 'top_customer',
    kind: 'view',
    state: 'waiting',
    error: null
  }
]
status [
  {
    dataset: 'customer_labels',
    kind: 'computed',
    state: 'current',
    error: null
  },
  {
    dataset: 'customer_totals',
    kind: 'view',
    state: 'current',
    error: null
  },
  {
    dataset: 'paid_orders',
    kind: 'view',
    state: 'current',
    error: null
  },
  {
    dataset: 'top_customer',
    kind: 'view',
    state: 'current',
    error: null
  }
]
labels [
  { customer: 'anna', label: 'anna paid 20.5 in 2 orders' },
  { customer: 'omar', label: 'omar paid 30 in 1 orders' }
]
top [ { customer: 'omar' } ]
```

## What the output shows

- **`pipeline.derived` gives the members in the place of the composite.** The list has `paid_orders`, `customer_totals` and `customer_labels`, then the host view `top_customer`. It does not have `order_report`.
- **A composite fails as one dataset, and the error names the member.** The run rejects with the `DerivedDatasetError` of `order_report`. Its `cause` is the `DerivedDatasetError` of `customer_totals`, whose cause is the error of SQLite.
- **The first member that fails stops the members after it.** `paid_orders` is `current`. `customer_totals` is `failed`, with the error. `customer_labels` has no row: it did not refresh, so it did not read a relation that the failed member left out of step.
- **A dataset after the composite waits while the member that it reads has no relation.** `top_customer` reads `customer_totals`, and the failed view is not in the file. Thus `top_customer` is `waiting`, not `failed`, and the run gives one error only.
- **The next refresh tries the composite again from its first member.** In the second run, each member and `top_customer` are `current`. `customer_labels` reads the totals of `customer_totals`.

## Things to know

- **A name must be distinct.** The name of the composite and the name of each member must be distinct from all other names of `derived`. Else the run or the watch rejects with a `TypeError` before it reads. See [Declare a composite dataset](../../README.md#declare-a-composite-dataset).
- **The pipeline validates the composite, and then each member,** before any connection reads.
- **A member cannot be a composite.** The type of `members` holds derived datasets only, and the list cannot be empty.
- **A watch gives the failure once.** It yields `{ kind: 'refresh', dataset: 'order_report', error }`, where `error` is the `DerivedDatasetError` of the member. The commit refreshes skip a composite whose last refresh failed. The refresh after the next pass tries it again. See [ADR 0031](../adr/0031-a-dataset-failure-fails-only-its-dataset-and-a-watch-gives-it-beside-its-passes.md).
- **Each member keeps its own row of `derived_status`.** See [ADR 0025](../adr/0025-each-derived-dataset-tells-readers-how-current-it-is.md).
- **The three vectorizers of `@eltjs/vectorizer` are composites.** See `packages/vectorizer/src/sqlite/vectorizer.ts`, `packages/vectorizer/src/postgresql/vectorizer.ts` and `packages/vectorizer/src/sqlserver/vectorizer.ts`, from commit `86b42be2`.
