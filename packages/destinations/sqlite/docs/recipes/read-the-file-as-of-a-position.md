# Recipe: Read the file as of a position

**Use case.** A reader wants to know what changed in the SQLite file between two times, for example which prices changed since Monday. The reader keeps a position of the file, and later reads the file as it was at that position and as it is now. A reader that copies a table into a database of its own copies it as of the position, too.

**What you need.** A source, a `SQLiteDestination` with a `retention`, and a `SQLiteCheckpointStore`. The retention is 30 days by default. This program sets 1 second, so that it can outwait it.

## The steps

1. Run a pass. Keep a position from `destination.positions()`.
2. Run a later pass that changes a row.
3. Read the file as of the position with `destination.reading(position)`, and as it is now with `destination.reading()`.
4. To copy a table as of the position into a different database, attach the SQLite file there and run the `SELECT` that `asOfSelect(database, table, position, { schema })` gives, in one read transaction.
5. After the retention, a commit deletes the history that only positions before the window read. A reading of such a position gives `{ expired }`.

## The program

```ts title="read-as-of-a-position.ts"
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { open } from '@zukhruf/sqlite-open';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  Pipeline,
  Source,
  type SourceMessage,
  Stream,
} from '@eltjs/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
  asOfSelect,
} from '@eltjs/elt-sqlite';

const prices = new Stream({
  name: 'prices',
  jsonSchema: {
    type: 'object',
    properties: {
      sku: { type: 'string', description: 'Product code.' },
      price: { type: 'integer', description: 'Price in cents.' },
      version: { type: 'integer', description: 'Version of the price.' },
    },
    required: ['sku', 'price', 'version'],
  },
  primaryKey: ['sku'],
  supportedSyncModes: ['incremental'],
});

// A source that gives the prices of one pass.
class Prices extends Source {
  readonly identity = 'prices';
  protected readonly catalog = new Catalog([prices]);
  readonly #rows: readonly SourceMessage[];

  constructor(rows: readonly SourceMessage[]) {
    super();
    this.#rows = rows;
  }

  override coverage() {
    return { description: 'Prices', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  override changeSignals() {
    return [];
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *extract(_configuration: CopyConfiguration) {
    yield* this.#rows;
  }
}

const directory = await mkdtemp(join(tmpdir(), 'elt-as-of-'));
try {
  // A short retention, so that the program outwaits it.
  const destination = new SQLiteDestination({
    path: join(directory, 'shop.sqlite'),
    retention: Temporal.Duration.from({ seconds: 1 }),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(directory, 'state.sqlite'),
  });
  const pass = (rows: readonly SourceMessage[]) =>
    new Pipeline({
      clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'shop',
          source: new Prices(rows),
          destination,
          checkpoints,
          steps: [
            new Copy(prices, destination.table('prices'), {
              id: 'prices',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
              cursorField: 'version',
            }),
          ],
        }),
      ],
    }).run();
  const price = (sku: string, cents: number, version: number) => ({
    stream: 'prices',
    data: { sku, price: cents, version },
  });

  await pass([price('tea', 300, 1), price('milk', 120, 1)]);
  const positions = destination.positions();
  if ('expired' in positions) throw new Error(positions.expired);
  const [monday] = positions;
  if (monday === undefined) throw new Error('No position yet');

  await pass([price('tea', 350, 2)]);

  // The file as of the first pass, and as it is now.
  const then = destination.reading(monday);
  if ('expired' in then) throw new Error(then.expired);
  using _then = then;
  console.log(
    'as of',
    then.position,
    then.sql.prepare('SELECT sku, price FROM prices ORDER BY sku').all(),
  );
  const now = destination.reading();
  if ('expired' in now) throw new Error(now.expired);
  using _now = now;
  console.log(
    'now',
    now.position,
    now.sql.prepare('SELECT sku, price FROM prices ORDER BY sku').all(),
  );

  // Copy the table as of the first pass into a database of the reader.
  using copy = open(':memory:');
  copy.prepare('ATTACH DATABASE ? AS "shop"').run(destination.path);
  copy.exec('BEGIN');
  const select = asOfSelect(copy, 'prices', monday, { schema: 'shop' });
  if (typeof select !== 'string') throw new Error(select.expired);
  copy.exec(`CREATE TEMP TABLE "monday" AS ${select}`);
  copy.exec('COMMIT');
  console.log(
    'copied',
    copy.prepare('SELECT sku, price FROM temp."monday" ORDER BY sku').all(),
  );

  // After the retention, the next commit deletes the history that only the
  // first position reads.
  await delay(1500);
  await pass([price('milk', 130, 2)]);
  console.log('positions', destination.positions());
  const expired = destination.reading(monday);
  console.log('expired' in expired ? expired : 'still readable');
} finally {
  await rm(directory, { recursive: true, force: true });
}
```

Run it from the workspace root with Node.js 26:

```sh
node read-as-of-a-position.ts
```

The output (the epoch is a new UUID in each run):

```
as of 2692099e-8c1e-403e-83d0-dd575706fe90:1 [
  [Object: null prototype] { sku: 'milk', price: 120 },
  [Object: null prototype] { sku: 'tea', price: 300 }
]
now 2692099e-8c1e-403e-83d0-dd575706fe90:2 [
  [Object: null prototype] { sku: 'milk', price: 120 },
  [Object: null prototype] { sku: 'tea', price: 350 }
]
copied [
  [Object: null prototype] { sku: 'milk', price: 120 },
  [Object: null prototype] { sku: 'tea', price: 300 }
]
positions [
  '2692099e-8c1e-403e-83d0-dd575706fe90:2',
  '2692099e-8c1e-403e-83d0-dd575706fe90:3'
]
{
  expired: 'Position 2692099e-8c1e-403e-83d0-dd575706fe90:1 is older than the retention of this file: its history keeps no row that only a reading before commit 2 reads'
}
```

## Why it works

Each commit has a number. The second pass changes the price of tea, so its commit copies the old row into the history of `prices`, with `replaced_in` 2. A reading as of position 1 shows each current row with `committed_in` ≤ 1 and each history row with `committed_in` ≤ 1 < `replaced_in`. `asOfSelect` gives the same `SELECT`, with the names of the attached file. See [ADR 0009](../adr/0009-the-sqlite-file-numbers-its-commits-and-keeps-a-history-of-each-row.md).

The third pass commits after the retention. Its commit finds position 2, the newest position that is older than the window. It deletes each history row with `replaced_in` ≤ 2, and it sets min valid to 2. Thus `positions()` starts at position 2, and position 1 is expired.

## Things to know

- **Min valid never passes the newest position.** A pass that stays open longer than the retention does not expire the position before it.
- **Check the position in the read transaction of the copy.** `asOfSelect` checks the position when you call it. A commit after the transaction can expire the position.
- **A position of a file that was made again is expired, too.** The new file has a new epoch.
- **The sync history keeps no versions.** A reading as of a position before the newest commit fails each read of it.
