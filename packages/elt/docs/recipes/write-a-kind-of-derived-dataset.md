# Recipe: Write a kind of derived dataset whose output is not one row for each key

**Use case.** A host loads notes, and a reader wants one row for each word of the notes, with the number of notes that have the word. A `View` cannot do this, because SQL alone cannot split a text into words. A `ComputedDataset` cannot do it either, because it keeps one output for each key: one row for each note, not one row for each word that many notes share. Without its own kind of derived dataset, the host counts the words after each run, and a reader sees counts that are not in step with the loaded notes.

**What you need.** `DerivedDataset` of `@eltjs/elt`, and the parts that elt-sqlite gives a kind in another package: `openDestination`, `SQLiteDerivedStatus` and `quote`. See [Write a kind of derived dataset in another package](../../../destinations/sqlite/README.md#write-a-kind-of-derived-dataset-in-another-package) in elt-sqlite. `transaction` of `@zukhruf/sqlite-transaction` opens the transaction of the refresh.

## The steps

1. Extend `DerivedDataset<SQLiteTable>`. Give it a `name`, the destination whose file holds its table, and the tables that it reads.
2. In `validate(connections)`, refuse with no I/O a declaration that the copies of the pipeline cannot feed, for example a name that a copy of the same file makes.
3. In `refresh({ clock, signal })`, open the file with `openDestination(path)`, and make a `SQLiteDerivedStatus` for the dataset.
4. Read the inputs and write the output in one `immediate` transaction. Write only the rows that changed, and delete the rows that no input gives any more.
5. Write the derived status: `current(counts)` when the refresh ends, `waiting()` when an input table is not there yet, and `failed(error)` before you throw a dataset failure.
6. Declare the dataset in `derived` of the `Pipeline`.

## The program

The program loads three notes through an `IterableSource` into a SQLite file, and the dataset `word_counts` counts their words. The second run changes one note and drops another. Then a pipeline that gives the dataset the name of the copy's table is refused. The program prints only the words that are in more than one note, and `bank` and `cheese`. Run it from a temporary file inside `packages/elt`, as [rule 7 of the docs guide](../../../../docs/writing-package-docs.md#recipe) says.

```ts title="word-counts.ts"
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { open } from '@zukhruf/sqlite-open';
import { transaction } from '@zukhruf/sqlite-transaction';

import {
  Connection,
  Copy,
  DerivedDataset,
  IterableSource,
  Pipeline,
  type PipelineClock,
  errorMessage,
} from '@eltjs/elt';
import {
  SQLiteDerivedStatus,
  SQLiteDestination,
  SQLiteSyncHistory,
  type SQLiteTable,
  openDestination,
  quote,
} from '@eltjs/elt-sqlite';

// One row for each word of the notes, with the number of notes that have it.
// Many notes give one word, so this is not one output for each key, and SQL
// alone cannot split the text into words.
class WordCounts extends DerivedDataset<SQLiteTable> {
  readonly name: string;
  readonly #into: SQLiteDestination;
  readonly #from: SQLiteTable;

  constructor(options: {
    into: SQLiteDestination;
    name: string;
    from: SQLiteTable;
  }) {
    super();
    this.name = options.name;
    this.#into = options.into;
    this.#from = options.from;
  }

  override validate(connections: readonly Connection<SQLiteTable>[]): void {
    const made = connections
      .filter(
        ({ destination }) =>
          destination instanceof SQLiteDestination &&
          destination.path === this.#into.path,
      )
      .flatMap(({ steps }) => steps)
      .flatMap(({ to }) => [to.name, to.raw])
      .map((name) => name.toLowerCase());
    if (made.includes(this.name.toLowerCase()))
      throw new TypeError(
        `Word counts ${this.name} has the name of a table that a copy makes`,
      );
  }

  override async refresh({
    clock,
    signal,
  }: {
    readonly clock: PipelineClock;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    using database = openDestination(this.#into.path);
    const status = new SQLiteDerivedStatus(
      database,
      this.name,
      'computed',
      clock,
    );
    const table = quote(this.name);
    let counts: { readonly inputs: number; readonly computed: number };
    try {
      counts = transaction(
        database,
        () => {
          database.exec(
            `CREATE TABLE IF NOT EXISTS ${table} ("word" TEXT PRIMARY KEY, "notes" INTEGER NOT NULL) STRICT`,
          );
          const notes = database
            .prepare(`SELECT "text" FROM ${quote(this.#from.name)}`)
            .all();
          const words = new Map<string, number>();
          for (const { text } of notes)
            for (const word of new Set(
              String(text)
                .toLowerCase()
                .match(/\p{L}+/gu),
            ))
              words.set(word, (words.get(word) ?? 0) + 1);
          const upsert = database.prepare(
            `INSERT INTO ${table} ("word", "notes") VALUES (?, ?) ON CONFLICT ("word") DO UPDATE SET "notes" = excluded."notes" WHERE "notes" IS NOT excluded."notes"`,
          );
          for (const [word, count] of words) upsert.run(word, count);
          const remove = database.prepare(
            `DELETE FROM ${table} WHERE "word" = ?`,
          );
          for (const { word } of database
            .prepare(`SELECT "word" FROM ${table}`)
            .all())
            if (!words.has(String(word))) remove.run(word);
          return { inputs: notes.length, computed: words.size };
        },
        { mode: 'immediate' },
      );
    } catch (error) {
      // The copy makes its table in its first commit; until then, wait.
      if (
        Error.isError(error) &&
        /^no such table: (?:main\.)?(.+)$/
          .exec(error.message)?.[1]
          ?.toLowerCase() === this.#from.name.toLowerCase()
      ) {
        await status.waiting();
        return;
      }
      // A stop is not the dataset's failure.
      if (signal?.aborted !== true) await status.failed(errorMessage(error));
      throw error;
    }
    await status.current({ ...counts, empty: 0, failed: 0, pending: 0 });
  }
}

let notes = [
  { id: 'n1', text: 'Buy milk and bread.' },
  { id: 'n2', text: 'Bread for the picnic.' },
  { id: 'n3', text: 'Call the bank.' },
];
const source = new IterableSource({
  identity: 'notes',
  streams: {
    notes: {
      description: 'Each note that the host holds now.',
      jsonSchema: {
        type: 'object',
        description: 'A note.',
        properties: {
          id: { type: 'string', description: 'Id of the note.' },
          text: { type: 'string', description: 'Text of the note.' },
        },
        required: ['id', 'text'],
      },
      primaryKey: ['id'],
      deletions: 'closed-world',
      snapshot: () => notes,
    },
  },
});

const directory = await mkdtemp(join(tmpdir(), 'word-counts-'));
try {
  const sqlite = new SQLiteDestination({
    path: join(directory, 'notes.sqlite'),
  });
  const table = sqlite.table('notes');
  const connection = new Connection({
    name: 'notes',
    source,
    destination: sqlite,
    steps: [
      new Copy(source.streams.notes, table, {
        syncMode: 'full_refresh',
        destinationSyncMode: 'overwrite_dedup',
      }),
    ],
  });
  const pipeline = new Pipeline({
    history: new SQLiteSyncHistory(),
    clock: globalThis,
    connections: [connection],
    derived: [
      new WordCounts({ into: sqlite, name: 'word_counts', from: table }),
    ],
  });

  const show = (label: string) => {
    using database = open(sqlite.path, { readOnly: true });
    const words = database
      .prepare(
        'SELECT word, notes FROM word_counts WHERE notes > 1 OR word IN (?, ?) ORDER BY word',
      )
      .all('bank', 'cheese')
      .map((row) => ({ ...row }));
    const status = database
      .prepare(
        'SELECT dataset, kind, state, inputs, computed, error FROM derived_status',
      )
      .get();
    console.log(label, words, { ...status });
  };

  await pipeline.run();
  show('first');

  // The host changes one note and stops holding another.
  notes = [
    { id: 'n1', text: 'Buy milk, bread and cheese.' },
    { id: 'n2', text: 'Bread for the picnic.' },
  ];
  await pipeline.run();
  show('second');

  // A dataset that has the name of the copy's table is refused before the
  // pipeline reads.
  const clash = new Pipeline({
    history: new SQLiteSyncHistory(),
    clock: globalThis,
    connections: [connection],
    derived: [new WordCounts({ into: sqlite, name: 'notes', from: table })],
  });
  await clash.run().catch((error: unknown) => {
    console.log('refused', String(error));
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
```

Output:

```
first [
  { word: 'bank', notes: 1 },
  { word: 'bread', notes: 2 },
  { word: 'the', notes: 2 }
] {
  dataset: 'word_counts',
  kind: 'computed',
  state: 'current',
  inputs: 3,
  computed: 9,
  error: null
}
second [ { word: 'bread', notes: 2 }, { word: 'cheese', notes: 1 } ] {
  dataset: 'word_counts',
  kind: 'computed',
  state: 'current',
  inputs: 2,
  computed: 8,
  error: null
}
refused TypeError: Word counts notes has the name of a table that a copy makes
```

## Why it works

- **The pipeline owns when, and the dataset owns how.** The pipeline calls `refresh` in the background after each commit of a copy, and one more time after the passes of a run ([ADR 0017](../adr/0017-each-commit-asks-for-a-refresh.md), [ADR 0002](../adr/0002-a-run-refreshes-its-derived-data-also-when-copies-failed.md)). `refresh` only brings the data in step with what the copies committed, so it is safe to repeat (`packages/elt/src/core/derived-dataset.ts`).
- **The refresh reads only what committed.** Each commit of a copy is one write transaction of the SQLite file ([Locks and commits](../../../destinations/sqlite/README.md#locks-and-commits) in elt-sqlite). The refresh opens its own connection, and SQLite shows that connection only committed rows. The `immediate` transaction takes the write lock before it reads, so no commit of a copy comes between the read of the notes and the write of the counts. A reader sees the counts of one refresh or of the next, never a part of one. The keyword index of [`@eltjs/vectorizer`](../../../vectorizer/src/sqlite/keyword-index.ts) does the same.
- **The output is not one row for each key.** `refresh` gets no inputs and no keys from the pipeline. It reads all of the notes, and it decides which rows its own table has. The second run shows this: the note with `bank` is gone, so `bank` leaves the output and `the` is in one note only; `cheese` comes from the changed note.
- **The dataset writes its own row of `derived_status`.** `SQLiteDerivedStatus` writes the row, with the kind `'computed'`, and readers see it in the view `derived_status`. `inputs` and `computed` are the counts that the refresh gives: 3 notes and 9 words, then 2 notes and 8 words.
- **`validate` refuses before the pipeline reads.** The third pipeline rejects with the `TypeError` of `validate`, and no copy runs.

## Things to know

- **A table that is not there yet is no failure.** The copy makes its table in its first commit. Until then, the read fails with `no such table`, and the dataset writes `waiting()`. The keyword index waits for its parts table in the same way.
- **Any other error is a dataset failure.** Write `failed(errorMessage(error))`, then throw the error. The pipeline gives it as a `DerivedDatasetError`, and the refresh after the next pass tries the dataset again. Do not write `failed` when `signal` aborted, because a stop is not a failure of the dataset. See [ADR 0031](../adr/0031-a-dataset-failure-fails-only-its-dataset-and-a-watch-gives-it-beside-its-passes.md).
- **`refresh` also gets `connections`, `earlier` and `trigger`.** Read the tables of the copies from `connections` when the dataset does not take them in its constructor, as `Reports` of what-is-going-on, a host in context-compiler, does (`apps/what-is-going-on/src/reports.ts`). `earlier` holds the derived datasets that this refresh follows, so a dataset that reads one of them can wait while it waits, as `View` of elt-sqlite does. `trigger` says whether a commit or the end of the passes asks for the refresh. `ComputedDataset` uses it to try a failed input at most once for each pass.
- **Write only what changed.** The upsert changes a row only when its count is different, and the delete removes only the words that are gone. A refresh makes again only what changed, as the glossary says for [Refresh](../../CONTEXT.md).
- **The commits of this dataset take no commit number.** elt-sqlite does not export its load in `_elt_loads`; only its own `ComputedDataset` makes one (`packages/destinations/sqlite/src/computed-dataset.ts`). Thus a [position](../../../destinations/sqlite/README.md#commit-numbers-and-positions) of the file numbers no commit of `word_counts`.
- **A Postgres kind follows the same steps** with the parts of elt-postgresql, such as `PostgresDerivedStatus`. See the keyword index of [`@eltjs/vectorizer` for Postgres](../../../vectorizer/src/postgresql/keyword-index.ts).
- **One rule for each key is a computed dataset, and one declaration that makes many derived datasets, its members, is a composite dataset.** See [Write a rule for a computed dataset](./write-a-rule-for-a-computed-dataset.md) and [Write a composite dataset](./write-a-composite-dataset.md).
