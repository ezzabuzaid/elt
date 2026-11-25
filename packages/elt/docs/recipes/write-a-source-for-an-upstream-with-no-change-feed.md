# Recipe: Write a source for an upstream with no change feed

**Use case.** A reading app keeps a user's reading list in one JSON file. It writes the full file again on each change. The file holds only the books of now: it does not tell which book changed, and a removed book is simply not in it. A host wants the list in SQL, and it wants each run to write only what changed and to delete the rows of removed books. A source that only yields each book loads with a full refresh, which writes each row on each run. ipay's `ImportsSource` ([source](https://github.com/ezzabuzaid/context-compiler/blob/main/apps/ipay/src/source/imports-source.ts)) and websets' `DefinitionsSource` ([source](https://github.com/ezzabuzaid/context-compiler/blob/main/apps/websets/src/definitions/definitions-source.ts)) are sources of this kind in Context Compiler.

**What you need.** A subclass of `Source` with a `Catalog` of one `Stream`, `diffSnapshot` of `@eltjs/elt`, `ClosedWorld` of `@zukhruf/snapshot-differential`, and a `Gauge` for the change signal. The program loads into `SQLiteDestination` of `@eltjs/elt-sqlite` and keeps its checkpoints in a `SQLiteCheckpointStore`.

## The steps

1. Declare the stream with `primaryKey`, `sourceDefinedCursor: true` and `supportedSyncModes: ['full_refresh', 'incremental']`. Declare `emitsDeletes: true` when the upstream deletes records. Thus the stream is a snapshot stream ([Snapshot streams](../../README.md#snapshot-streams)).
2. Put the stream in a `Catalog`, and give the catalog as the `protected readonly catalog` of the source.
3. In `open`, read the upstream one time for the full pass, and return it as the read context, an `AsyncDisposable` ([Read context](../../README.md#read-context)).
4. In `extract`, give one complete scan to `diffSnapshot(configuration, records, state, { policy, signal })`. Give `new ClosedWorld()` as the deletion policy when the scan lists every record.
5. Implement `coverage(stream)`, `currentAsOf(stream)` and `changeSignals(streams, clock)`. A change signal is a gauge, the streams that it tells about, and the interval and timeout of its checks ([ADR 0020](../adr/0020-a-source-gives-its-change-signals-and-a-failed-signal-fails-only-its-streams.md)).
6. Copy the stream with an `id`, `syncMode: 'incremental'` and `destinationSyncMode: 'append_dedup'`, and give the connection a checkpoint store.

## The program

The program writes the reading list, runs the pipeline, then writes the list again with one book changed and one book removed, and runs the pipeline two more times. After each run it prints the counts of the copy and the rows of the target. The program runs from a temporary file in `packages/elt`, so `@eltjs/elt-sqlite` resolves through the workspace's `node_modules`.

```ts title="reading-list-source.ts"
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TemporaryFiles } from '@zukhruf/fs';
import { ClosedWorld } from '@zukhruf/snapshot-differential';
import { open } from '@zukhruf/sqlite-open';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  type CopyConfiguration,
  type ExtractionCoverage,
  Gauge,
  Pipeline,
  Source,
  type SourceMessage,
  Stream,
  diffSnapshot,
} from '@eltjs/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@eltjs/elt-sqlite';

type Book = { id: string; title: string; status: string };

// The read context: the list as one read of the file gave it, so each
// stream of the pass sees the same moment of the upstream.
class ReadingList implements AsyncDisposable {
  readonly books: readonly Book[];

  constructor(books: readonly Book[]) {
    this.books = books;
  }

  async [Symbol.asyncDispose]() {}
}

// The change signal: the time when the app last wrote the file.
class Written extends Gauge<number> {
  readonly #path: string;

  constructor(path: string) {
    super();
    this.#path = path;
  }

  protected async read() {
    return (await stat(this.#path)).mtimeMs;
  }
}

// The upstream is a JSON file that a reading app writes again on each
// change. It has no change feed: it holds only the books of now.
class ReadingListSource extends Source<ReadingList> {
  readonly identity = 'reading-list';
  readonly books = new Stream({
    name: 'books',
    jsonSchema: {
      type: 'object',
      description: 'A book on the reading list.',
      properties: {
        id: { type: 'string', description: 'The book identifier.' },
        title: { type: 'string', description: 'The title of the book.' },
        status: {
          type: 'string',
          description: 'to-read, reading or finished.',
        },
      },
      required: ['id', 'title', 'status'],
    },
    primaryKey: ['id'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
    supportedSyncModes: ['full_refresh', 'incremental'],
  });
  protected readonly catalog = new Catalog([this.books]);
  readonly #path: string;

  constructor(path: string) {
    super();
    this.#path = path;
  }

  override coverage(): ExtractionCoverage {
    return { description: 'Every book in the reading list.', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  override changeSignals(streams: readonly Stream[]): ChangeSignal[] {
    return [
      {
        gauge: new Written(this.#path),
        streams,
        interval: 1000,
        timeout: 1000,
      },
    ];
  }

  protected override async open() {
    const books: Book[] = JSON.parse(await readFile(this.#path, 'utf8'));
    return new ReadingList(books);
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    list: ReadingList,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    // The scan lists every book, so a book that it does not list was deleted.
    yield* diffSnapshot(configuration, list.books, state, {
      policy: new ClosedWorld(),
      signal,
    });
  }
}

await using directory = await new TemporaryFiles().directory('reading-list-');
const path = join(directory.path, 'reading-list.json');
const source = new ReadingListSource(path);
const sqlite = new SQLiteDestination({
  path: join(directory.path, 'books.sqlite'),
});
const pipeline = new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'reading-list',
      source,
      destination: sqlite,
      checkpoints: new SQLiteCheckpointStore({
        path: join(directory.path, 'checkpoints.sqlite'),
      }),
      steps: [
        new Copy(source.books, sqlite.table('books'), {
          id: 'books-to-sqlite',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        }),
      ],
    }),
  ],
  clock: globalThis,
});

async function runAndShow(label: string) {
  const [result] = await pipeline.run();
  using database = open(sqlite.path, { readOnly: true });
  const rows = database
    .prepare('SELECT id, title, status FROM books ORDER BY id')
    .all()
    .map((row) => ({ ...row }));
  console.log(label, { count: result?.count, deleted: result?.deleted });
  console.log(rows);
}

await writeFile(
  path,
  JSON.stringify([
    {
      id: 'b1',
      title: 'Designing Data-Intensive Applications',
      status: 'reading',
    },
    { id: 'b2', title: 'Domain-Driven Design', status: 'to-read' },
    { id: 'b3', title: 'Refactoring', status: 'to-read' },
  ]),
);
await runAndShow('Run 1:');

// The app writes the list again: b1 is finished, and the user removed b2.
await writeFile(
  path,
  JSON.stringify([
    {
      id: 'b1',
      title: 'Designing Data-Intensive Applications',
      status: 'finished',
    },
    { id: 'b3', title: 'Refactoring', status: 'to-read' },
  ]),
);
await runAndShow('Run 2:');

await runAndShow('Run 3, no change:');
```

Output:

```
Run 1: { count: 3, deleted: 0 }
[
  {
    id: 'b1',
    title: 'Designing Data-Intensive Applications',
    status: 'reading'
  },
  { id: 'b2', title: 'Domain-Driven Design', status: 'to-read' },
  { id: 'b3', title: 'Refactoring', status: 'to-read' }
]
Run 2: { count: 1, deleted: 1 }
[
  {
    id: 'b1',
    title: 'Designing Data-Intensive Applications',
    status: 'finished'
  },
  { id: 'b3', title: 'Refactoring', status: 'to-read' }
]
Run 3, no change: { count: 0, deleted: 0 }
[
  {
    id: 'b1',
    title: 'Designing Data-Intensive Applications',
    status: 'finished'
  },
  { id: 'b3', title: 'Refactoring', status: 'to-read' }
]
```

## What the output shows

- **Run 1** has no checkpoint (state `null`). The diff loads the three books and deletes nothing.
- **Run 2** compares the new scan with the snapshot of run 1. Only `b1` changed, so `count` is 1. `b2` vanished, and `ClosedWorld` judges it deleted, so the diff emits a `DELETE` and `deleted` is 1. The row of `b2` goes from the target. `b3` did not change, and it makes no write.
- **Run 3** reads the same file again. Nothing changed, so the copy writes nothing.

The test `snapshot diffs load only changes, delete vanished keys and survive replay` in [elt-sqlite's index.test.ts](../../../destinations/sqlite/src/index.test.ts) proves the same behavior.

## Things to know

- **The scan must be complete.** An empty scan deletes all rows. Thus a source throws on a failed read, and never yields an empty list in place of the read ([Snapshot streams](../../README.md#snapshot-streams)).
- **The source still reads each record on each run.** Only the writes of the destination become fewer. The checkpoint holds one key and a fingerprint for each row, so it grows with the stream.
- **A stream with `sourceDefinedCursor` deduplicates with `replace`** when its copy gives no `dedupPolicy`, so the newest scan wins ([Dedup policy](../../README.md#dedup-policy)).
- **`changeSignals` is a declaration.** It does no I/O. The gauge opens what it reads in its first read. This program only runs and never watches, so no watch reads its gauge. Under `pipeline.watch()`, a changed modification time of the file starts a pass ([Watch for changes](../../README.md#watch-for-changes)).
- **`currentAsOf` returns `null`** because the file is current each time that the source reads it. A store that its app writes only while the app runs returns the time of its last write ([How current a stream is](../../README.md#how-current-a-stream-is), [ADR 0014](../adr/0014-a-source-says-how-current-each-stream-s-upstream-is.md)).
- **A full refresh uses the same `extract`.** In a full refresh, `diffSnapshot` emits each record of the scan and saves no state.
- **Other upstreams need a different deletion policy.** An upstream that drops old records uses `Retention` ([Expiring upstreams](../../README.md#expiring-upstreams)). An upstream that holds only a part uses `Coverage` ([Partly held upstreams](../../README.md#partly-held-upstreams)). Inputs that the source can fingerprint without a read, such as files, use `diffGroupedSnapshot` ([Grouped snapshots](../../README.md#grouped-snapshots)).
- **An error that the user must fix goes in `configErrors`.** The failure type of each other error is `system` ([Failure types](../../README.md#failure-types)).
