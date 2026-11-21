# Recipe: Load a stream into SQL Server and read it as of a position

**Use case.** A host copies the tasks of a to-do app into SQL Server. A reader wants to know what changed between two passes, for example which task was done since Monday. The reader keeps a position, and later reads the tables as they were at that position and as they are now.

**What you need.** A source, a `SqlServerDestination`, a `SqlServerSyncHistory` and a `SqlServerCheckpointStore`, all with one login. The database must be SQL Server 2025 or Azure SQL, with `READ_COMMITTED_SNAPSHOT` and `ALLOW_SNAPSHOT_ISOLATION` on (see "Load a stream into SQL Server" in the [README](../../README.md)).

## The steps

1. Run a pass. Keep a position from `destination.positions()`.
2. Run a later pass that removes a row, changes a row and adds a row.
3. Read `marts.tasks` as of the position with `destination.reading(position)`, and as it is now with `destination.reading()`.

## The program

The program reads the ADO.NET connection string from `SQLSERVER_LOGIN`. It ran on SQL Server 2025 (RTM-CU11) in Docker, in an empty database with row versioning on. Run from `packages/destinations/sqlserver` after `nx run elt-sqlserver:build`, with `SQLSERVER_LOGIN='Server=…;Database=…;User Id=…;Password=…' node load-a-stream-and-read-it-as-of-a-position.ts`.

```ts title="load-a-stream-and-read-it-as-of-a-position.ts"
import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  Pipeline,
  Source,
  Stream,
} from '@eltjs/elt';
import {
  SqlServerCheckpointStore,
  SqlServerDestination,
  SqlServerSyncHistory,
} from '@eltjs/elt-sqlserver';

// The tasks of a to-do app, as its API gives them on each read.
class TodoApp extends Source {
  readonly identity = 'todo-app';
  tasks = [
    { id: 't1', title: 'Order the panels', done: false },
    { id: 't2', title: 'Book the crane', done: false },
  ];
  readonly stream = new Stream({
    name: 'tasks',
    jsonSchema: {
      type: 'object',
      description: 'A task of the to-do app.',
      properties: {
        id: { type: 'string', description: 'Task id.' },
        title: { type: 'string', description: 'Task title.' },
        done: { type: 'boolean', description: 'Whether the task is done.' },
      },
      required: ['id'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
  });
  protected readonly catalog = new Catalog([this.stream]);

  override coverage() {
    return { description: 'Every task.', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  // This program only runs and never watches.
  override changeSignals() {
    return [];
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *extract(configuration: CopyConfiguration) {
    for (const task of this.tasks)
      yield { stream: configuration.stream.name, data: task };
  }
}

// An ADO.NET connection string, such as
// Server=localhost,1433;Database=warehouse;User Id=elt;Password=…;TrustServerCertificate=true
const login = process.env.SQLSERVER_LOGIN!;
const app = new TodoApp();
const warehouse = new SqlServerDestination({ login });
const pipeline = new Pipeline({
  clock: globalThis,
  history: new SqlServerSyncHistory({ login }),
  connections: [
    new Connection({
      name: 'todo',
      source: app,
      destination: warehouse,
      checkpoints: new SqlServerCheckpointStore({ login }),
      steps: [
        new Copy(app.stream, warehouse.table('tasks'), {
          id: 'todo:tasks',
          syncMode: 'full_refresh',
          destinationSyncMode: 'overwrite',
        }),
      ],
    }),
  ],
});

const tasksAsOf = async (position?: string) => {
  const reading = await warehouse.reading(position);
  if ('expired' in reading) throw new Error(reading.expired);
  await using _ = reading;
  console.log(`marts.tasks as of ${reading.position}:`);
  console.table(
    await reading.sql.query(
      'SELECT id, title, done FROM marts.tasks ORDER BY id',
    ),
  );
};

await pipeline.run();
const [first] = await warehouse.positions();

// The next read of the app: t1 is gone, t2 is done, t3 is new.
app.tasks = [
  { id: 't2', title: 'Book the crane', done: true },
  { id: 't3', title: 'Pour the slab', done: false },
];
await pipeline.run();

console.log({ positions: await warehouse.positions() });
await tasksAsOf(first);
await tasksAsOf();
```

Output:

```
{
  positions: [
    '3240C191-2095-4355-A10B-977BBB34180F:2004',
    '3240C191-2095-4355-A10B-977BBB34180F:2005'
  ]
}
marts.tasks as of 3240C191-2095-4355-A10B-977BBB34180F:2004:
┌─────────┬──────┬────────────────────┬───────┐
│ (index) │ id   │ title              │ done  │
├─────────┼──────┼────────────────────┼───────┤
│ 0       │ 't1' │ 'Order the panels' │ false │
│ 1       │ 't2' │ 'Book the crane'   │ false │
└─────────┴──────┴────────────────────┴───────┘
marts.tasks as of 3240C191-2095-4355-A10B-977BBB34180F:2005:
┌─────────┬──────┬──────────────────┬───────┐
│ (index) │ id   │ title            │ done  │
├─────────┼──────┼──────────────────┼───────┤
│ 0       │ 't2' │ 'Book the crane' │ true  │
│ 1       │ 't3' │ 'Pour the slab'  │ false │
└─────────┴──────┴──────────────────┴───────┘
```

## Why it works

Each pass is one commit, whose number is the `rowversion` of its row in `_warehouse._elt_commits` ([ADR 0002](../adr/0002-a-commit-number-is-the-rowversion-of-its-commit-row.md)). A position is `<epoch>:<number>`. The second pass is an `overwrite`: it deletes `t1` and the old `t2` by difference, and the same statement keeps them in the history of the table with `replaced_in` 2005.

`reading(position)` opens a session of its own in a `SNAPSHOT` transaction and sets `elt.position` in its session context as a read-only key. The reader view `marts.tasks` reads the rows of the raw table with `committed_in <= 2004` and the rows of the history with `committed_in <= 2004 < replaced_in` ([ADR 0010](../adr/0010-a-reading-sets-its-position-in-the-session-context-and-reads-row-versions.md)). `reading()` with no position reads the newest position.

## Things to know

- **Dispose each reading.** `await using` ends its session. A reading holds one connection until then.
- **A position can expire.** After the retention (30 days unless set), a commit deletes the history that only older positions read, and `reading(position)` gives `{ expired }` with the reason.
- **The numbers are not dense.** Another `rowversion` of the database takes numbers too, so two positions can differ by more than 1.
