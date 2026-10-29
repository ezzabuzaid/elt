# @workspace/elt-sqlite

The SQLite destination of elt. It keeps the stream of each copy as a raw table in one SQLite file, with a reader view over it and a catalog that describes each table, view and column. A reader queries the file with SQL, for example with `sqlite3 -readonly`. The SQLite destination also has two kinds of derived dataset: a `View`, which SQLite computes on each read, and a `ComputedDataset`, which a rule computes on write. A dbt model has the same two kinds: it is materialized as a view or as a table.

This README tells how the SQLite destination keeps columns, commits, checkpoints and the sync history, and how it keeps derived datasets. The pipeline itself is in [elt](../../elt/README.md).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md), and the glossary of [elt](../../elt/CONTEXT.md) for the words of all of elt.

## Columns

`sqlite.table(name)` infers the columns from the JSON Schema of the stream. `sqlite.table(name, (columns) => [...])` declares them. `SQLiteColumns.fromSchema(schema)` gives the inferred columns, so a declaration can add to them.

Inferred columns map flat JSON Schema fields:

| JSON Schema                                                     | SQLite                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `string`                                                        | `TEXT`                                                                                      |
| `integer`                                                       | `INTEGER`                                                                                   |
| `number`                                                        | `REAL`                                                                                      |
| `boolean`                                                       | `INTEGER` with a 0/1 `CHECK`                                                                |
| `array`                                                         | `TEXT` that holds a JSON array, with `CHECK (json_valid(...) AND json_type(...) = 'array')` |
| `string` + `format: 'int64'`                                    | `INTEGER`                                                                                   |
| `string` + `contentEncoding: 'base64'`                          | `BLOB`                                                                                      |
| `string` + `format: 'decimal'`                                  | `TEXT`                                                                                      |
| `string` + `date`, `date-time`, `date-time-local`, `time-local` | `TEXT`, with a `CHECK` that keeps the canonical form and its width                          |

- Read an array with `json_each`.
- The `data_type` of the catalog names each [string format](../../elt/README.md#string-formats) with its precision and scale, such as `timestamp(7)` or `decimal(19,4)`. A millisecond `date-time` stays `timestamp`.
- Nullable scalars and arrays are possible for normal fields. A missing optional field becomes SQL `NULL`.
- Explicit columns are `text`, `integer`, `int64`, `real`, `boolean`, `date`, `timestamp`, `localTimestamp(precision)` and `blob`. `int64` and `localTimestamp` keep the `int64` and `date-time-local` formats as an inferred column keeps them: the same value, `CHECK` and catalog `data_type`. A local timestamp has no default precision, so you give it. They permit null unless you mark them `.notNull()` or `.primaryKey()`. A missing or undefined explicit field fails. An explicit projection can leave out nested fields that SQLite cannot hold.
- Table and column names follow the [naming rule](../../elt/README.md#names). SQLite compares names without ASCII case, and it has no length limit.

Tables:

- SQLite makes strict tables. SQL constraints that exist stay in force.
- Each copy adds `loaded_at`, the UTC start time of the load. A field with that name gets a different column name.
- Deduplication upserts on a unique index that is named after the table and the key (`_elt_dedup_<hash>`). SQLite makes the index one time, and makes it again only when the key changes. It uses the native [UPSERT with a cursor comparison](https://www.sqlite.org/lang_upsert.html).
- Deduplication also checks the stored types of the key and cursor columns, and refuses null keys and cursors.
- A change to a normal `append` or `overwrite` removes the index of the mode. Explicit constraints stay.
- A table of append history with repeated keys must be replaced with `overwrite_dedup` before incremental deduplication can start.
- When the stored definition of a table does not agree with the columns of the stream, the load [evolves it](../../elt/README.md#shape-changes) before it reads. SQLite cannot change the type or the constraints of a column in place. Thus, in one transaction, the rows move, column by name, into a table of the new definition. That table takes the name of the table, with its index and its reader view. A value that its type or a `CHECK` refuses fails the load, and the table stays as it was.
- An overwrite reloads such a table into a hidden table `_elt_next_<hash>`. The hidden table replaces the table and its reader view when the stream ends ([resets](../../elt/README.md#resets)).
- The writer of each target is in the reserved table `_elt_writers` ([target ownership](../../elt/README.md#target-ownership)).

Counts:

- The `count` of a committed copy is the number of accepted input observations, also deduplication no-ops.
- `deleted` is the number of accepted deletions, also keys that were not there.
- Neither count is the final number of rows.

## File bytes in the database

`c.blob('bytes').from(notes.attachments.file)` keeps the original bytes of a file in the SQLite file, not in a [file storage](../../elt/README.md#local-files). It does not depend on `.store(files)`. The file and its row then commit together. See [stored files](../../elt/README.md#stored-files-and-document-parsing) in elt for the declarations.

SQLite stores an original file in chunks, because one BLOB has a limit of 1,000,000,000 bytes (`SQLITE_MAX_LENGTH` in the build of Node), and a value of the full file would stay in memory.

- The `bytes` column holds an `INTEGER` file id.
- A table `_elt_files_<hash>` for each column holds `(file, n, bytes)` rows of up to 4 MiB. `n` counts from 0.
- The hash is the first 40 hex characters of the SHA-256 of `JSON.stringify([table, column])`, with the two names in ASCII lower case. Thus table `a_b` with column `c` and table `a` with column `b_c` keep their chunks apart.
- The description of the column names its chunk table.
- An empty file has one empty chunk. A file that is not available gives a null value.
- Triggers remove the chunks of a row in the same transaction when the row is deleted, overwritten or replaced. A record that a deduplication guard refuses stores no chunks.

Read a file back in order, with the chunk table that the description names:

```sql
SELECT c.bytes FROM "_elt_files_<hash>" AS c
WHERE c.file = (SELECT bytes FROM attachments WHERE id = ?)
ORDER BY c.n;
```

Checked on 2026-09-24 (macOS 26.6.2, Node.js 26.8.1): a file of 1.5 GB loaded as 358 chunks in 3.3 s, with a peak RSS of 137 MiB. The chunks put together again had the SHA-256 of the file.

## Locks and commits

- SQLite takes no lock other than its transactions. Loads into one file run side by side. A [checkpoint store](#checkpoints) keeps two runs of one copy apart.
- No transaction stays open between commits, as in Postgres.
- `prepare` only refuses and stages. It refuses the target of a different writer, a reader view that is not its own, and stored rows that a deduplicating load cannot keep.
- Each commit is one write transaction. The first commit also makes the table, the index of its mode, its reader view, its descriptions and its writer.
- Other writers of the file wait only for a commit. A stream that fails before its first commit leaves nothing.
- Each stream stages its operations in a `TEMP` table that only its connection sees. The commit of a different stream never publishes them, and a crash leaves nothing.
- A commit merges the staged operations of one stream into its table. The result is the same as when the operations apply one at a time: a staged `DELETE` removes its key, only the records after the last `DELETE` of a key count, `replace` keeps the last record, and `cursor_newer` keeps the first record with the greatest cursor.
- Original files stream into a `TEMP` chunk table that only the connection sees, and they get to the store in the commit of their rows. After each merge, SQLite deletes the chunks that no row refers to. A clear empties the store.
- A file column that the target drops takes its chunk table with it when the table evolves or a reload replaces it.
- `:memory:` is possible only for a full refresh. The database of the run is gone when its handle closes, so it cannot keep incremental progress.

## Checkpoints

`SQLiteCheckpointStore({ path })` keeps the checkpoints of incremental copies in a table `checkpoints` (`id`, `binding`, `reloading`, `state`) in its own file. Use it with SQLite destinations.

- The file is owner-only (`0600`).
- Use a file that is not a SQLite destination file. Its parent folder must exist. `:memory:` is refused.
- The store holds one lock for each copy `id` through `SqliteStore` of `@zukhruf/mutex/sqlite`, in a `<path>.locks` folder beside the file. Different IDs run in parallel. A run that finds one ID in use releases the IDs that it took and fails with `Checkpoint <id> is in use by another run`. The kernel releases a lock when its process stops. See [ADR 0005](./docs/adr/0005-each-checkpointed-copy-has-its-own-lock.md).
- Each save commits by itself, so no checkpoint transaction stays open while the load runs.
- A `checkpoints` table that a different version declared in a different way is replaced with its checkpoints, so each copy starts again.

## Sync history

`SQLiteSyncHistory()` records each pass in the SQLite file that its connection loads, beside the data. See [sync history](../../elt/README.md#sync-history) in elt.

- It records only connections with a SQLite destination, and it refuses other connections when the pipeline validates. The destination must be a file, not `:memory:`.
- Its tables are `_elt_sync_attempts`, `_elt_extraction_coverage` and `_elt_stream_checks`. The last one holds the latest check of each stream by a watch that found it unchanged.
- `install()` makes those tables and publishes the views `sync_attempts`, `extraction_coverage`, `sync_status` and `stream_status`, and the [catalog](#the-catalog), in each file. The pipeline calls it before each run and watch. Tables that a different version declared in a different way are replaced, with their history.
- `new SQLiteSyncHistory({ soleWriter: true })` is for a host that knows that no other process runs a pass of its connections, such as the leader of the flight of a connection. Its install records as `failed` each pass of those connections that started and never ended, because the process that ran it ended first. Airbyte also fails the unfinished jobs of a connection before it starts the next. With no `soleWriter`, such a pass stays `running`, because a different process can still run it. See [ADR 0006](./docs/adr/0006-a-sole-writer-fails-the-passes-it-finds-unfinished.md).
- `target_schema` is `main` in SQLite.

## The catalog

The view `catalog` lists each table, view and column of the SQLite file that readers query, with its description. The sync history publishes it in each file that its connections load. `installSQLiteCatalog({ path })` publishes it in a file that no pipeline loads.

## Declare a view

```ts
import { View } from '@workspace/elt-sqlite';

const unread = new View({
  into: sqlite,
  name: 'unread_count',
  description: 'How many messages each chat has that the user did not read.',
  columns: {
    chat: 'The chat.',
    n: 'Number of messages that the user did not read.',
  },
  sql: 'SELECT chat, count(*) AS n FROM messages WHERE read = 0 GROUP BY chat',
});
```

Give the view to the pipeline in `derived`. `sqlite` is the `SQLiteDestination` of the copies.

- A view names no inputs. Its SQL reads them. See [ADR 0001](./docs/adr/0001-a-view-names-no-inputs.md).
- The view appears when its query compiles. Thus a reader never finds a view that fails.
- While the SQL reads a raw table or a reader view that a copy of the pipeline has not made yet, the view waits. It appears at the refresh after that copy loads.
- Any other error of the query, for example a misspelled table, is a dataset failure. It fails the run with the error of SQLite.
- The columns must be the same as the columns that the query gives, and the catalog lists them with their descriptions.
- A view that comes after a computed dataset in `derived` can read the view of that dataset.
- A refresh that changes nothing does not change the schema of the SQLite file.

## Declare a computed dataset

```ts
import { DocumentText } from '@workspace/elt';
import { ComputedDataset } from '@workspace/elt-sqlite';

const text = new ComputedDataset({
  into: sqlite,
  name: 'document_text',
  description: 'The text of each stored document.',
  from: [documents],
  compute: new DocumentText({
    parser: () => parser,
    files: files.directory,
    column: 'documentRef',
  }),
});
```

`documents` is the target of a copy, and `from` can name more than one. The rule reads each row that those copies loaded. See [Write a rule](../../elt/README.md#write-a-rule) in elt.

A computed dataset keeps one output row for each key, in the table `raw_<name>`. Readers query the view `<name>`:

| Column       | Holds                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| the key      | the key of the input, with the name that the rule gives, for example `ref`                                     |
| `input_hash` | the SHA-256 of the input                                                                                       |
| `rule`       | the rule identity, for example the parser of the format. `unsupported` when the rule does not handle the input |
| `status`     | `computed`, `empty` or `failed`                                                                                |
| `error`      | why the rule failed, or `NULL`                                                                                 |
| rule columns | the columns of the rule, for example `content`                                                                 |

At each refresh, the computed dataset compares the inputs with the output rows. See [ADR 0002](./docs/adr/0002-a-computed-dataset-keeps-one-output-row-for-each-key.md):

- It computes each key that is new, whose input or rule identity changed, or whose status is `failed`.
- It deletes each output row whose key no input has any more.
- It keeps an output row when the rule stops handling its input.
- Each call of the rule commits as it settles, so readers see the output rows as they land. See [ADR 0003](./docs/adr/0003-each-rule-call-commits-as-it-settles.md).
- When the declaration of the raw table changes, the refresh makes the table again. See [ADR 0004](./docs/adr/0004-a-changed-declaration-makes-the-table-again.md).

## When something fails

- **A rule failure** gives an output row with the status `failed` and the reason in `error`. The run continues, and the next refresh tries the input again.
- **A dataset failure**, for example a query that SQLite refuses, rejects the run, or it stops the watch.
- **A copy that failed** keeps its last committed rows. The derived datasets read those rows.

## Recipes

One use case each, with a full program that you can run:

- [Search the text of stored files with SQL](./docs/recipes/search-the-text-of-stored-files.md)

## Decisions

- [ADR 0001](./docs/adr/0001-a-view-names-no-inputs.md): a view names no inputs.
- [ADR 0002](./docs/adr/0002-a-computed-dataset-keeps-one-output-row-for-each-key.md): a computed dataset keeps one output row for each key.
- [ADR 0003](./docs/adr/0003-each-rule-call-commits-as-it-settles.md): each rule call commits as it settles.
- [ADR 0004](./docs/adr/0004-a-changed-declaration-makes-the-table-again.md): a changed declaration makes the table again.
- [ADR 0005](./docs/adr/0005-each-checkpointed-copy-has-its-own-lock.md): each checkpointed copy has its own lock.
- [ADR 0006](./docs/adr/0006-a-sole-writer-fails-the-passes-it-finds-unfinished.md): a sole writer fails the passes that it finds unfinished.

## Development

Run the commands from the workspace root.

```sh
npx nx run elt-sqlite:test        # builds, then runs src/*.test.ts
npx nx run elt-sqlite:typecheck   # formats, lints, then type checks
npx nx run elt-sqlite:build       # compiles src/ to dist/
```

The files of the destination:

```
src/
  sqlite-destination.ts      SQLiteDestination: tables and the load
  sqlite-writer.ts           the stage, the commit, evolve and reload of a table
  sqlite-checkpoint-store.ts SQLiteCheckpointStore
  sqlite-sync-history.ts     SQLiteSyncHistory
  sqlite-catalog.ts          installSQLiteCatalog
```

The files of derived datasets:

```
src/
  view.ts                    View: a view that SQLite computes on each read
  computed-dataset.ts        ComputedDataset: one output row for each key
  sqlite-views.ts            publishSQLiteViews: makes described views and checks their columns
  view.test.ts               the tests of View
  computed-dataset.test.ts   the tests of ComputedDataset, and of the refreshes of a run and a watch
```
