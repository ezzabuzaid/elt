# @eltjs/elt-sqlite

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

- Read an array with `json_each`. An array of objects is a JSON array of objects; read a field of each with `json_extract(value, '$.field')`.
- The `data_type` of the catalog names each [string format](../../elt/README.md#string-formats) with its precision and scale, such as `timestamp(7)` or `decimal(19,4)`. A millisecond `date-time` stays `timestamp`.
- Nullable scalars and arrays are possible for normal fields. A missing optional field becomes SQL `NULL`.
- Explicit columns are `text`, `integer`, `int64`, `real`, `boolean`, `date`, `timestamp`, `localTimestamp(precision)` and `blob`. `int64` and `localTimestamp` keep the `int64` and `date-time-local` formats as an inferred column keeps them: the same value, `CHECK` and catalog `data_type`. A local timestamp has no default precision, so you give it. They permit null unless you mark them `.notNull()` or `.primaryKey()`. A missing or undefined explicit field fails. An explicit projection can leave out nested fields that SQLite cannot hold.
- Table and column names follow the [naming rule](../../elt/README.md#names). SQLite compares names without ASCII case, and it has no length limit.

Tables:

- SQLite makes strict tables. SQL constraints that exist stay in force.
- Each copy adds `loaded_at`, the UTC start time of the load that wrote the values of the row. A field with that name gets a different column name.
- Each copy also adds `committed_in`, the number of the [commit](#commit-numbers-and-positions) that last wrote the row, and `_elt_row_hash`, the SHA-256 of the values of its columns. A [file in the SQLite file](#file-bytes-in-the-database) counts by the SHA-256 of its bytes, not by its id. A field with one of these names also gets a different column name. So does a field with the name `_rowid_`: SQLite reads that name as the id of each row, which an overwrite and a reload use.
- When a deduplicating load, an overwrite or a reload brings a row with the same values as a stored row, it leaves the stored row as it is, with its `loaded_at` and its `committed_in`. A deduplicating load finds the stored row by its key. An overwrite and a reload find it by [difference](#commit-numbers-and-positions), also in a table with no key.
- Deduplication upserts on a unique index that is named after the table and the key (`_elt_dedup_<hash>`). SQLite makes the index one time, and makes it again only when the key changes. It uses the native [UPSERT with a cursor comparison](https://www.sqlite.org/lang_upsert.html).
- Deduplication also checks the stored types of the key and cursor columns, and refuses null keys and cursors.
- A change to a normal `append` or `overwrite` removes the index of the mode. Explicit constraints stay.
- A table of append history with repeated keys must be replaced with `overwrite_dedup` before incremental deduplication can start.
- When the stored definition of a table does not agree with the columns of the stream, the load [evolves it](../../elt/README.md#shape-changes) before it reads. SQLite cannot change the type or the constraints of a column in place. Thus, in one transaction, the rows move, column by name, into a table of the new definition. That table takes the name of the table, with its index and its reader view. A value that its type or a `CHECK` refuses fails the load, and the table stays as it was.
- A row that has a value in a column that the table drops, or that it keeps as a different type, loses or changes that value. Thus the evolve takes a commit number of the load, the [history](#commit-numbers-and-positions) keeps each such row as it was, and the row gets the number in `committed_in`. Its `_elt_row_hash` counted the old value, so it becomes null: a null hash matches no record, and the next commit that writes the row gives it a new version. A column that the table adds is null in each row, and a null value does not count in `_elt_row_hash`. Thus it changes no row.
- An overwrite reloads such a table into a hidden table `_elt_next_<hash>`. The hidden table replaces the table and its reader view when the stream ends ([resets](../../elt/README.md#resets)).
- The writer of each target is in the reserved table `_elt_writers` ([target ownership](../../elt/README.md#target-ownership)).

Counts:

- The `count` of a committed copy is the number of accepted input observations, also deduplication no-ops.
- `deleted` is the number of accepted deletions, also keys that were not there.
- Neither count is the final number of rows.

## File bytes in the database

`c.blob('bytes').from(notes.attachments.file)` keeps the original bytes of a file in the SQLite file, not in a [file storage](../../elt/README.md#local-files). It does not depend on `.store(files)`. The file and its row then commit together. See [stored files](../../elt/README.md#stored-files-and-document-parsing) in elt for the declarations.

SQLite stores an original file in chunks, because one BLOB has a limit of 1,000,000,000 bytes (`SQLITE_MAX_LENGTH` in the build of Node), and a value of the full file would stay in memory.

- The `bytes` column holds an `INTEGER` file id. Each load gives each file a new id.
- A table `_elt_files_<hash>` for each column holds `(file, n, bytes)` rows of up to 4 MiB. `n` counts from 0.
- The ids of a chunk table only go up. The reserved table `_elt_file_ids` keeps the highest id that each chunk table gave, as `sqlite_sequence` keeps the highest rowid of a table with `AUTOINCREMENT`. Thus a new file never takes the id of a file that a row of the [history](#commit-numbers-and-positions) refers to, also when the chunk table was dropped and made again.
- The hash is the first 40 hex characters of the SHA-256 of `JSON.stringify([table, column])`, with the two names in ASCII lower case. Thus table `a_b` with column `c` and table `a` with column `b_c` keep their chunks apart.
- The description of the column names its chunk table.
- An empty file has one empty chunk. A file that is not available gives a null value.
- The chunks of a file stay while a row of the table or of its history refers to the file. Thus a [reading](#commit-numbers-and-positions) as of a position reads the bytes of each file that the position shows. When the [retention](#retention) deletes the last history row that refers to a file, the same commit deletes its chunks.
- A commit deletes the chunks of each file that it staged and that no row of the table or of its history refers to. Thus a record that a deduplication guard refuses stores no chunks. The commit that resets a partition, the commit at the end of a reload, and a clear delete the chunks of each file that no row of the table or of its history refers to.
- When a row with a file has the same values as a stored row, also the same file bytes, the stored row stays with its file id. The commit deletes the chunks of the new copy of the file.

Read a file back in order, with the chunk table that the description names:

```sql
SELECT c.bytes FROM "_elt_files_<hash>" AS c
WHERE c.file = (SELECT bytes FROM attachments WHERE id = ?)
ORDER BY c.n;
```

Checked on 2026-09-24 (macOS 26.6.2, Node.js 26.8.1): a file of 1.5 GB loaded as 358 chunks in 3.3 s, with a peak RSS of 137 MiB. The chunks put together again had the SHA-256 of the file.

## Locks and commits

- The SQLite file has a [persistent WAL](./CONTEXT.md). Each connection that writes the file opens it with `openDestination(path)`, which gives the journal `PersistentWriteAheadLog` of `@zukhruf/sqlite-open`. The last connection that writes the file and closes decides if the `-wal` and `-shm` files stay, so all of these connections use it. Use `openDestination` also in a host that opens the file to write.
- Readers never wait for a commit, and a commit never waits for readers.
- The `-wal` and `-shm` files stay after the last connection closes. Thus `sqlite3 -readonly` reads the file also from a folder that it cannot write, for example the folder of an agent in a sandbox.
- A connection that stops during a commit leaves only the committed rows. The next reader reads them at once, with no recovery step.
- A connection waits up to 30 seconds for the commit of a different connection.
- SQLite takes no lock other than its transactions. Loads into one file run side by side. A [checkpoint store](#checkpoints) keeps two runs of one copy apart.
- No transaction stays open between commits, as in Postgres.
- `prepare` only refuses and stages. It refuses the target of a different writer, a reader view that is not its own, and stored rows that a deduplicating load cannot keep.
- Each commit is one write transaction. The first commit also makes the table, the index of its mode, its reader view, its descriptions and its writer. A full refresh commits one time, when its stream ends. Thus an overwrite replaces the rows of the table in that one commit, and a reader never sees a part of it.
- Other writers of the file wait only for a commit. A stream that fails before its first commit leaves nothing.
- Each stream stages its operations in a `TEMP` table that only its connection sees. The commit of a different stream never publishes them, and a crash leaves nothing.
- A commit merges the staged operations of one stream into its table. The result is the same as when the operations apply one at a time: a staged `DELETE` removes its key, only the records after the last `DELETE` of a key count, `replace` keeps the last record, and `cursor_newer` keeps the first record with the greatest cursor.
- Original files stream into a `TEMP` chunk table that only the connection sees, and they get to the store in the commit of their rows.
- A file column that the target drops takes its chunk table with it when the table evolves or a reload replaces it. A reading as of a position reads only the columns of the table, so it does not read that column.
- `:memory:` is possible only for a full refresh. The database of the run is gone when its handle closes, so it cannot keep incremental progress.

## Commit numbers and positions

Each commit in the SQLite file has a number. A reader that compares the file at two times can find the positions where no pass is half done, as a Kafka consumer reads up to the last stable offset.

- The table `_elt_commits` has one row for each commit: its `number`, its `load` and its `committed_at`. SQLite writes one transaction at a time, so the numbers follow the order of the commits, also across connections.
- The table `_elt_loads` has one row for each load: its `connector` (the name of the connection) or its `dataset` (the name of a [computed dataset](#declare-a-computed-dataset)), its `opened_at`, and its `closed_at`, which is null while the load is open. A load of a connection opens when a pass starts to load, and closes when the pass ends. A load of a computed dataset opens when a refresh starts, and closes when the refresh ends, also when a stop or a failure ends it.
- A connection runs one pass at a time, and a computed dataset runs one refresh at a time. Thus when a load opens, it closes each load of the same connection or dataset that is still open: the process of that pass or refresh ended first. A closed load cannot commit. A load with no commit changes no position.
- A commit into a [hidden table](./CONTEXT.md) shows nothing to readers. When the stream ends, one more commit gives its rows to the table, and readers see them from that commit on.
- An overwrite and a reload replace the rows of the table by [difference](./CONTEXT.md). The difference compares the rows as multisets, so it needs no key. On each side, each row gets a number k among the rows with the same `_elt_row_hash`, and the k-th copy of some values matches the k-th copy of the same values on the other side:
  - A row with a match stays as it is, with its `committed_in` and its `loaded_at`.
  - A row of the table with no match goes into the history and leaves the table.
  - A new row with no match enters the table with the number of the commit.
- An overwrite applies the difference in its one commit, to the records that it staged. A reload applies it, to the rows of its hidden table, in the commit at the end of the stream. The table keeps its indexes, its triggers and its reader view. When the table has a different shape than the hidden table, the reload puts the hidden table in its place, and every row of the table goes into the history.
- A file in the SQLite file counts in `_elt_row_hash` by the SHA-256 of its bytes, which the load calculates while it stages the chunks. Each load gives the file a new id, but a row whose file has the same bytes matches. The row keeps its file id, and the commit deletes the chunks of the new copy.
- The table `_elt_epoch` keeps the epoch, an id that names the numbering. A file that is made again, or tables that a different version declared in a different way, start a new epoch.
- `destination.positions(after?)` gives the positions after the position `after`, in ascending order, or all positions. A position is `<epoch>:<number>`. It names the last commit of a closed load, when no other load has commits before and after it. With no `after`, it gives each position from [min valid](#retention) on. When `after` is of a different epoch, is after the newest commit, or is older than min valid, `positions` gives `{ expired }` with the reason. It opens the file read-only.
- A clear that empties a table is a load of one commit. It does not close the open loads of its connection.
- Each table has a [history](./CONTEXT.md) `_elt_history_<hash>`, which the table `_elt_histories` names. Before a commit changes or removes a row, it copies the row into the history, with `replaced_in`, its own number. This occurs for a deduplicated row with different values, a `DELETE`, the reset of a partition, a clear, a row that an overwrite or a reload does not bring again, the rows of a table that a reload of a different shape replaces, a row that loses or changes a value when its table evolves, and an output row of a computed dataset that a refresh changes or deletes. A commit into a hidden table copies nothing. The history has each column that the table had, and it does not drop a column. A field with the name `replaced_in` gets a different column name.
- A file that a row of the history refers to stays, in the SQLite file and in a [file storage](../../elt/README.md#local-files): the values that the destination gives the file storage to keep include the values of the history.
- The history gets the columns of the table when it is made. SQLite cannot add a column with the name `rowid` or `oid` to a table. Thus when a stream adds a field with one of these names later, a commit that keeps a row in the history fails. Delete the SQLite file to load it again.
- The reset of a partition copies each row of the partition into the history. The rows that the source sends again after the reset can come in later commits, for example after a checkpoint of each page. Thus no commit can know which rows of the partition left.
- `destination.reading(position?)` gives a [reading](./CONTEXT.md) of the file as of the position, or as of the newest position: `{ sql, position, at }`, where `sql` is a read-only `DatabaseSync` in one read transaction and `at` is the time of the commit. Dispose the reading to close it. A position of a different epoch, after the newest commit, or older than [min valid](#retention), gives `{ expired }`. A commit number that `positions` does not list, for example a commit inside a pass, makes `reading` throw a `TypeError`, as a string that is not a position does: a reading there would show a part of a pass. A position that `positions` listed stays a position, because no later load can have commits before and after it.
- As of a position before the newest commit, each table, its reader view and each view of the file show the rows that the commit of the position left. A column that a later commit added is `NULL`. The sync history keeps no versions, and a read of it fails. A stored view that names a table as `main.<table>` makes the reading fail, because that name shows the table as it is now.

- `asOfSelect(database, table, position, { schema })` gives the `SELECT` that reads one table as of a position: the rows of the table with `committed_in ≤ P`, and the rows of its history with `committed_in ≤ P < replaced_in`. A reading uses the same `SELECT` for its `TEMP` views. `schema` names the SQLite file where `database` attached it, `main` by default. Thus a reader can copy a table as of a position into a database of its own. It checks the position as `reading` does, so run the `SELECT` in the same read transaction. See [Read the file as of a position](./docs/recipes/read-the-file-as-of-a-position.md).
- `asOfDefinitions(database, { schema, position, prefix })` gives the `CREATE TEMP VIEW` statements of the [views of a position](./CONTEXT.md) of the file that `database` attached as `schema`, or `{ expired }` as `asOfSelect` does. Thus one connection reads several files as of a position each, with no copy. Each table, reader view, view and table of the sync history is the view `<prefix>_<name>`, for example `mail_messages`:
  - A table reads as `asOfSelect` reads it, without `_elt_row_hash`.
  - A stored view names the views of the position in place of its tables and views. SQLite's own `ALTER TABLE … RENAME` maps the names, in a database of its own with a table of the same columns for each name. A stored view that reads a table with no view of the position, for example `catalog`, fails when it is read.
  - A table of the sync history fails when it is read, and so does each view over it.
  - A view reads the file when it is read, so a later commit changes nothing in it. When the retention deletes history that the position reads, or the file is made again, each read of a table fails with the reason: in the same statement, the view compares the epoch and min valid of the file with the position.
  - The views fail through the SQL functions of `asOfFunctions`. Register each one on the connection: `database.function(name, implementation)`.

### Retention

The history keeps each position readable for the retention of the destination, as Delta Lake keeps its log:

```ts
new SQLiteDestination({
  path: 'import.sqlite',
  retention: Temporal.Duration.from({ days: 30 }), // the default
});
```

- In each commit, let W be the newest position whose commit is older than now minus the retention. The commit deletes each history row with `replaced_in ≤ W`, and the chunks of each file that only those rows refer to. It sets min valid, the column `min_valid` of `_elt_epoch`, to W. This is the `MIN_VALID_VERSION` of SQL Server change tracking.
- Min valid is a position, and it never passes the newest position. Thus a pass that stays open longer than the retention does not expire the position before it.
- A position older than min valid is expired: `reading`, `positions` and `asOfSelect` give `{ expired }` with a reason that names the retention.
- A file in a [file storage](../../elt/README.md#local-files) that only the deleted history rows refer to goes when the stream of its table next commits.
- The same commit deletes each row of `_elt_commits` with a number less than W, and each closed load of `_elt_loads` that has no commit left. W is a position, so each load with a commit before W ends at or before W. The row of W stays, because a reading as of W gives its `committed_at`. A `committed_in` of a row is only compared with numbers, so it needs no row in `_elt_commits`. An open load stays, also when it has no commit yet.
- A retention that is less than zero throws a `RangeError`. A retention in months or years throws a `RangeError` of `Temporal`, because their length depends on the date.

## Checkpoints

`SQLiteCheckpointStore({ path })` keeps the checkpoints of incremental copies in a table `checkpoints` (`id`, `binding`, `reloading`, `state`) in its own file. Use it with SQLite destinations.

- The checkpoint file and its `-wal` and `-shm` files are owner-only (`0600`). The checkpoint file has a write-ahead log, and SQLite deletes its `-wal` and `-shm` files when the last connection closes.
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
- `readPassStatus(path)` gives the latest pass of a SQLite file and the latest outcome of each stream. When several connections load the file, their latest passes show as one pass. It is `running` when one connection runs. Else it is `cancelled` when one pass stopped, `succeeded` when all passes succeeded, `failed` when all passes failed, and `partial` in all other cases. It starts with the first pass and completes with the last. Its error has the error of each pass that did not succeed, one on each line. Its failure type is `config` when one pass has a `config` failure. Its last success and its `current_as_of` are the earliest of the passes, or null when one pass has no value. When no file is at the path, it gives no pass and no streams. See [ADR 0008](./docs/adr/0008-a-file-that-several-connections-load-shows-one-pass.md).

## Reserved names

The destination and its sync history own each table, index and view whose name starts with `_elt_`, in any case. Examples are `_elt_writers`, `_elt_descriptions`, `_elt_commits`, the chunk tables `_elt_files_<hash>` and the sync history's `_elt_sync_attempts`. A stream, a view or a computed dataset never has such a name, and `publishSQLiteViews` refuses one. A reader that follows the data of a file, such as a changefeed, skips these tables with `isReserved(name)`:

```ts
import { isReserved } from '@eltjs/elt-sqlite';

for (const event of batch) if (!isReserved(event.table)) await accept(event);
```

## The catalog

The view `catalog` lists each table, view and column of the SQLite file that readers query, with its description. The sync history publishes it in each file that its connections load. `installSQLiteCatalog({ path })` publishes it in a file that no pipeline loads.

## Declare a view

```ts
import { View } from '@eltjs/elt-sqlite';

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
- While the SQL reads a view that comes before it in `derived` and that still waits, the view waits too, as dbt skips a model whose upstream model was skipped. Both appear at the refresh after the copy loads.
- Any other error of the query, for example a misspelled table, is a dataset failure. It fails the run with the error of SQLite.
- The columns must be the same as the columns that the query gives, and the catalog lists them with their descriptions.
- A view that comes after a computed dataset in `derived` can read the view of that dataset.
- A refresh that changes nothing does not change the schema of the SQLite file.

## Declare a computed dataset

```ts
import { DocumentText } from '@eltjs/elt';
import { ComputedDataset } from '@eltjs/elt-sqlite';

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

`from` can also name a `View` that comes before the computed dataset in `derived`. Then the rule reads each row that the view gives, as a dbt model reads the model that it refs. For example, a view keeps the latest version of each record, and the computed dataset reads only those rows. While the view waits for its tables, the computed dataset has no input from it.

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

- It computes each key that is new, or whose input or rule identity changed. The refresh after the passes also computes each key whose status is `failed`, once for each pass ([ADR 0007](./docs/adr/0007-each-pass-tries-an-input-at-most-once.md)).
- It deletes each output row whose key no input has any more.
- It keeps an output row when the rule stops handling its input.
- Each call of the rule commits as it settles, so readers see the output rows as they land. See [ADR 0003](./docs/adr/0003-each-rule-call-commits-as-it-settles.md).
- When the declaration of the raw table changes, the refresh makes the table again. See [ADR 0004](./docs/adr/0004-a-changed-declaration-makes-the-table-again.md).

A refresh is a load in `_elt_loads`, so a [reading](#commit-numbers-and-positions) shows the computed dataset as of a position, as it shows a table that a copy loads:

- Each transaction of the refresh that changes a row takes one commit number. A transaction that changes no row takes none. No commit inside a refresh that is open is a position.
- The raw table has the columns `committed_in` and `_elt_row_hash` after the columns of the rule. The view `<name>` does not show them. `_elt_row_hash` is the SHA-256 of the values of the other columns, as for a copy.
- A rule column cannot have the name of the key, of an engine column, of `committed_in` or of `_elt_row_hash`, in any ASCII case, as SQLite compares column names. The constructor of `ComputedDataset` refuses such a rule with a `TypeError` that names the column and the dataset.
- When the rule makes a row again with the same values, for example a `failed` row that fails again with the same error, the row stays as it is, with its `committed_in`.
- Before a commit changes or deletes an output row, it copies the row into the [history](./CONTEXT.md) of the raw table. When the declaration changes, the commit that makes the table again copies each row of the old table into the history. A column that the old table did not have is `NULL` as of a position before.

## When something fails

- **A rule failure** gives an output row with the status `failed` and the reason in `error`. The run continues, and the refresh after the next pass tries the input again.
- **A dataset failure**, for example a query that SQLite refuses, rejects the run, or it stops the watch, with a `DerivedDatasetError` that names the dataset.
- **A table that is gone**, for example one that a person dropped by hand, is no failure. A computed dataset that reads it waits and keeps its output rows. When the copy loads the table again, the dataset asks the rule only for inputs that changed.
- **A copy that failed** keeps its last committed rows. The derived datasets read those rows.

## Recipes

One use case each, with a full program that you can run:

- [Search the text of stored files with SQL](./docs/recipes/search-the-text-of-stored-files.md)
- [Read the file as of a position](./docs/recipes/read-the-file-as-of-a-position.md)

## Decisions

- [ADR 0001](./docs/adr/0001-a-view-names-no-inputs.md): a view names no inputs.
- [ADR 0002](./docs/adr/0002-a-computed-dataset-keeps-one-output-row-for-each-key.md): a computed dataset keeps one output row for each key.
- [ADR 0003](./docs/adr/0003-each-rule-call-commits-as-it-settles.md): each rule call commits as it settles.
- [ADR 0004](./docs/adr/0004-a-changed-declaration-makes-the-table-again.md): a changed declaration makes the table again.
- [ADR 0005](./docs/adr/0005-each-checkpointed-copy-has-its-own-lock.md): each checkpointed copy has its own lock.
- [ADR 0006](./docs/adr/0006-a-sole-writer-fails-the-passes-it-finds-unfinished.md): a sole writer fails the passes that it finds unfinished.
- [ADR 0007](./docs/adr/0007-each-pass-tries-an-input-at-most-once.md): each pass tries an input at most once.
- [ADR 0008](./docs/adr/0008-a-file-that-several-connections-load-shows-one-pass.md): a file that several connections load shows one pass.
- [ADR 0009](./docs/adr/0009-the-sqlite-file-numbers-its-commits-and-keeps-a-history-of-each-row.md): the SQLite file numbers its commits and keeps a history of each row.

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
  open-destination.ts        openDestination: the open of each connection that writes the file
  sqlite-writer.ts           the stage, the commit, evolve, reload and the difference of a table
  sqlite-loads.ts            SQLiteLoad: the loads and commit numbers of a file, its positions and its retention
  sqlite-history.ts          SQLiteHistory: the history of a table, and the rows that the retention deletes
  sqlite-as-of.ts            readings, asOfSelect and asOfFunctions: the file as of a position
  sqlite-as-of-definitions.ts asOfDefinitions: the views of a position of an attached file
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
  computed-as-of.test.ts     the tests of the commits, the positions and the history of a refresh
```
