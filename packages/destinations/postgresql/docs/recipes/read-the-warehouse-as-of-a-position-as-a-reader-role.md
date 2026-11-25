# Recipe: Read the warehouse as of a position as a reader role

**Use case.** An agent reads the warehouse with a read-only role, such as `agent_reader`, while the pipeline loads with the role that owns the database. The agent wants each pass whole: it must not see half of a load, and it must be able to read the warehouse again as it was at an earlier position. A reading needs the numbering in `_warehouse`. Without the package, the host grants those objects by hand, names objects that are not its own, and loses the grant when the numbering is made again (#4492).

**What you need.** A Postgres server, the loading role's URL, and a reader role that may read `marts`. `PostgresSyncHistory` with `readers`, and a second `PostgresDestination` with the URL of the reader role.

## The steps

1. Give the reader role its grants on `marts`, as a grant of the database: `USAGE` on `marts`, and `SELECT` on its relations through default privileges. The pipeline does not give them.
2. Name the reader role on the sync history: `new PostgresSyncHistory({ url, readers: ['agent_reader'] })`. Each install grants the reader role what a reading needs, and nothing else of `_warehouse`.
3. Run the pipeline with the loading role's URL.
4. Make `new PostgresDestination({ url: readerUrl })`. No load goes through it.
5. Call `positions()` to get the positions, or `reading(position?)` to read the warehouse as of one. Each call gives `{ expired }` when it cannot read. Check it first.
6. Dispose each reading with `await using`, which ends its session.

## The program

The program makes the reader role `agent_reader`, runs two passes of one stream of notes, and then reads as `agent_reader`: the positions, the reader view as of each position, an expired position, and a raw table.

Start a Postgres server with pgvector, the image that the tests of the package use:

```sh
docker run -d --name elt-reader-recipe -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55432:5432 pgvector/pgvector:pg18
```

The program makes the role `agent_reader` and the schema `marts`. A role belongs to the server, not to one database, so the program needs a server that has no role `agent_reader`, such as the new container above. A server of this repository's infra already has `agent_reader` (`infra/init/01-roles.sh`), and the program fails there at `CREATE ROLE`. Set `POSTGRES_URL` to use another server.

```ts title="read-as-a-reader.ts"
import postgres from 'postgres';

import { Connection, Copy, IterableSource, Pipeline } from '@eltjs/elt';
import {
  PostgresDestination,
  PostgresSyncHistory,
} from '@eltjs/elt-postgresql';

// The loading role, which owns the database.
const url =
  process.env.POSTGRES_URL ??
  'postgres://postgres:postgres@127.0.0.1:55432/postgres';

// The reader role: it reads marts and nothing else. Its grants on marts are
// grants of the database, which the pipeline does not give.
await using clients = new AsyncDisposableStack();
const sql = clients.adopt(
  postgres(url, { max: 1, onnotice: () => {} }),
  (client) => client.end(),
);
await sql.unsafe(`
  CREATE ROLE agent_reader LOGIN PASSWORD 'agent';
  CREATE SCHEMA marts;
  GRANT USAGE ON SCHEMA marts TO agent_reader;
  ALTER DEFAULT PRIVILEGES IN SCHEMA marts GRANT SELECT ON TABLES TO agent_reader;
`);
const readerUrl = new URL(url);
readerUrl.username = 'agent_reader';
readerUrl.password = 'agent';

// The notes that the host holds. A real host reads them from its own store.
let notes = [{ id: 'n1', title: 'Buy milk' }];
const source = new IterableSource({
  identity: 'notes',
  streams: {
    notes: {
      description: 'Each note that the host holds now.',
      jsonSchema: {
        type: 'object',
        description: 'A note.',
        properties: {
          id: { type: 'string', description: 'Note id.' },
          title: { type: 'string', description: 'Title of the note.' },
        },
        required: ['id', 'title'],
      },
      primaryKey: ['id'],
      deletions: 'closed-world',
      snapshot: () => notes,
    },
  },
});
const warehouse = new PostgresDestination({ url });
const pipeline = new Pipeline({
  clock: globalThis,
  // agent_reader reads the warehouse as of a position with its own session.
  history: new PostgresSyncHistory({ url, readers: ['agent_reader'] }),
  connections: [
    new Connection({
      name: 'notes',
      source,
      destination: warehouse,
      steps: [
        new Copy(source.streams.notes, warehouse.table('notes'), {
          syncMode: 'full_refresh',
          destinationSyncMode: 'overwrite_dedup',
        }),
      ],
    }),
  ],
});

await pipeline.run();
notes = [
  { id: 'n1', title: 'Buy oat milk' },
  { id: 'n2', title: 'Call the bank' },
];
await pipeline.run();

// The positions and readings of the database, as agent_reader. No load goes
// through this destination.
const reader = new PostgresDestination({ url: readerUrl.href });
const positions = await reader.positions();
if ('expired' in positions) throw new Error(positions.expired);
console.log({ positions });

for (const position of positions) {
  const reading = await reader.reading(position);
  if ('expired' in reading) throw new Error(reading.expired);
  await using _reading = reading;
  const rows = await reading.sql`SELECT id, title FROM marts.notes ORDER BY id`;
  console.log(reading.position, [...rows]);
}

// A position of another epoch is expired.
console.log(await reader.reading('another-epoch:1'));

// agent_reader has no grant on the raw tables in _warehouse.
const now = await reader.reading();
if ('expired' in now) throw new Error(now.expired);
await using _now = now;
console.log(
  await now.sql`SELECT * FROM _warehouse.raw_notes`.catch(
    (error: Error) => error.message,
  ),
);
```

Output (the epoch changes from run to run; this run set `POSTGRES_URL` to a server on another port):

```
{
  positions: [
    '7a000809-9bcc-460b-b51e-49898aaffa4d:1',
    '7a000809-9bcc-460b-b51e-49898aaffa4d:2'
  ]
}
7a000809-9bcc-460b-b51e-49898aaffa4d:1 [ { id: 'n1', title: 'Buy milk' } ]
7a000809-9bcc-460b-b51e-49898aaffa4d:2 [
  { id: 'n1', title: 'Buy oat milk' },
  { id: 'n2', title: 'Call the bank' }
]
{
  expired: 'Position another-epoch:1 is of an earlier numbering: the commits of this database were numbered again since'
}
permission denied for table raw_notes
```

## Why it works

- **The install grants the numbering to each reader role.** The pipeline installs the sync history before each run. Each install grants `agent_reader` `USAGE` on `_warehouse` and `SELECT` on the numbering, so `positions()` and `reading()` work with the URL of `agent_reader`. The install makes the numbering when the database has none yet. See [ADR 0007](../adr/0007-readers-are-named-on-the-sync-history.md) and [Sync history](../../README.md#sync-history).
- **A position is the last commit of a closed load.** The first pass made position 1 and the second pass made position 2. A reading as of a position shows no part of a pass. See [Commit numbers and positions](../../README.md#commit-numbers-and-positions).
- **A reading shows each reader view as of its position.** `reading(position)` opens its own session and a `REPEATABLE READ READ ONLY` transaction. Below the newest position, it also sets `elt.position`, which each reader view reads; a reading at the newest position sets nothing, and each reader view shows the newest rows. As of position 1, `marts.notes` shows the note before the second pass changed it. The history of the raw table keeps the replaced row.
- **A position of another epoch is expired.** The reading gives `{ expired }` with the reason, and does not throw. A string that is not a position throws a `TypeError`.
- **The reader role gets nothing else of `_warehouse`.** The raw table `_warehouse.raw_notes` refuses `agent_reader`. Read through the reader view in `marts`. See [ADR 0010](../adr/0010-readers-look-in-marts-and-elt-keeps-its-tables-in-warehouse.md).

## Things to know

- **A role that does not exist fails the install.** Make the reader role before the pipeline runs. In this repository, `infra/init/01-roles.sh` makes `agent_reader`; see [infra](../../../../../infra/README.md).
- **Who may read `marts` stays a grant of the database.** The install grants only what a reading needs. Give `marts` with default privileges, as step 1 does.
- **apps/proactive uses this pattern.** `apps/proactive/src/pipeline.ts` names `agent_reader` on its sync history. `apps/proactive/src/main.ts` gives `reader.positions()` and `reader.reading()` to the automations, and `apps/proactive/src/add-rule.ts` checks `{ expired }` and disposes the reading with `await using`.
- **A retention or a clear expires old positions.** A reading before `min_valid` gives `{ expired }` with the reason. See [Commit numbers and positions](../../README.md#commit-numbers-and-positions).
- **Each reading holds one session.** A reader role with a connection limit, such as the 5 connections of `agent_reader` in infra, can hold only that many readings at one time.
