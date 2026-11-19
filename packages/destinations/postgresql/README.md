# @eltjs/elt-postgresql

The Postgres destination of elt. It loads each table of a connection into one schema of a Postgres database, with typed columns, and it does not block readers while it loads. It can keep a reader view of each table in a different schema, such as `marts`, and it publishes documented SQL views that the application defines. It also has a checkpoint store and a sync history that keep their data in the same database.

This README tells about the Postgres destination. The pipeline itself is in [elt](../../elt/README.md). The database of the repository, its roles and its `marts` schema are in [infra](../../../infra/README.md).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md), and the glossary of [elt](../../elt/CONTEXT.md) for the words of all of elt.

## Load a stream into Postgres

```ts
import { Connection, Copy, Pipeline } from '@eltjs/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@eltjs/elt-postgresql';

const url = 'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';
const warehouse = new PostgresDestination({ url, schema: 'apple_notes' });

await new Pipeline({
  history: new PostgresSyncHistory({ url }),
  connections: [
    new Connection({
      name: 'apple-notes',
      source: notes,
      destination: warehouse,
      checkpoints: new PostgresCheckpointStore({ url, schema: 'apple_notes' }),
      steps: [
        new Copy(
          notes.notes,
          warehouse.table('raw_notes').withReaderView('marts', 'notes'),
          {
            id: 'apple-notes:notes',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          },
        ),
      ],
    }),
  ],
}).run();
```

- `PostgresDestination({ url, schema })` loads each table of a connection into one schema. The first load makes the schema.
- The URL holds credentials, so `location()`, which checkpoints keep, names only the schema and the table. `destination.url` gives the URL to the views and computed datasets of the destination; it is a getter, so JSON and `util.inspect` do not show it.
- The destination checks the declarations without a connection to the database.
- A schema name must have at most 63 bytes, must not hold NUL, and must not start with `pg_`.

## Columns

Inferred columns follow the stream schema. The [string formats](../../elt/README.md#string-formats) get their own types, so readers can do date arithmetic:

| JSON Schema                                     | Postgres                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `string`                                        | `TEXT`                                                             |
| `string` + `format: 'date'`                     | `DATE`                                                             |
| `string` + `format: 'date-time'`, precision ≤ 6 | `TIMESTAMPTZ`                                                      |
| `string` + `format: 'date-time-local'`, ≤ 6     | `TIMESTAMP`                                                        |
| `string` + `format: 'time-local'`, ≤ 6          | `TIME`                                                             |
| any of those three at precision 7–9             | `TEXT`, sorted with `COLLATE "C"`                                  |
| `string` + `format: 'int64'`                    | `BIGINT`                                                           |
| `string` + `format: 'decimal'`                  | `NUMERIC(precision, scale)`, or `NUMERIC` when not declared        |
| `string` + `contentEncoding: 'base64'`          | `BYTEA`                                                            |
| `integer`                                       | `BIGINT`                                                           |
| `number`                                        | `DOUBLE PRECISION`                                                 |
| `boolean`                                       | `BOOLEAN`                                                          |
| `array` of any of the above                     | a native array of that type, such as `BIGINT[]` or `TIMESTAMPTZ[]` |
| `array` of objects                              | `JSONB[]`, one `jsonb` object for each element                     |

- Postgres keeps time to the microsecond. A time with more fraction digits, such as the `datetime2(7)` of SQL Server, stays exact text. It sorts in time order, because each value of the column has the same width. Cast it (`::timestamp`) for date arithmetic, which rounds.
- A `TIMESTAMPTZ` keeps the instant. It does not keep the offset that the value had.
- Arrays keep the order of their elements, and load a JSON `null` as SQL `NULL`. Readers use `= ANY(...)`, `unnest()` and `cardinality()`. `marts.catalog` shows the type of the element.
- ISO dates count years astronomically, and Postgres does not. Thus the year `0000` loads as `0001 BC`, which is the same day. Each other year is written as it is given.
- Explicit columns are `columns.text`, `integer`, `real`, `boolean`, `date`, `timestamp` and `blob(field)`, with `.notNull()` and `.primaryKey()`. `columns.int64(field)` is a `BIGINT` that loads decimal text exactly, and `columns.localTimestamp(field, precision)` is a `TIMESTAMP` for SQL Server's `datetime2`, by the rows of the table above: a precision past 6 loads as text.
- A plain `blob()` stores `BYTEA`. `blob().from(file)` keeps the original file in chunk tables, and `text().from(file).parse(parser)` stores the parsed text as `TEXT`. See [file bytes in the database](#file-bytes-in-the-database).
- Table, view and column names follow the [naming rule](../../elt/README.md#names). Postgres compares names with their case, keeps 63 bytes of a name, and reserves `loaded_at`, `committed_in`, `replaced_in` and the system column names `xmin`, `xmax`, `cmin`, `cmax`, `ctid` and `tableoid`. The naming rule turns a field `_elt_row_hash` into `elt_row_hash`, so no field takes that name.

## File bytes in the database

Postgres takes the same `text().from(file).parse(parser)` and `blob().from(file)` declarations as SQLite. See [stored files](../../elt/README.md#stored-files-and-document-parsing) in elt.

- Parsed content is `TEXT`.
- The column of an original file holds a UUID. Its bytes are in a table `_elt_files_<hash>` for each column, in the schema of the destination, as `(file UUID, n BIGINT, bytes BYTEA)` chunks of up to 4 MiB.
- The hash is the first 40 hex characters of the SHA-256 of `JSON.stringify([tableName, columnName])`.
- To read the original, join on the file UUID and order by `n`.
- An empty file has one empty chunk. A file that is not available gives a null value.
- The chunks of a load wait in a `TEMP` table that only the session sees, until the commit of their rows moves them. A discard empties that table.
- After each merge, the commit removes the chunks that no row of the table, or of its hidden table while a reload is open, refers to, for example the chunks of a record that deduplication refused.
- A clear of a copy also removes its files.
- A plain `blob()` column with no `.from(file)` stores an inline `BYTEA` value.

## Descriptions

Sources describe their data with the `description` of JSON Schema: at the root for the meaning of the source record, and on each property for the meaning of the field, its nulls, its units and its relations in the source. These descriptions belong to the source. They hold no names of destination tables. Notes describes its five streams and their fields in this way.

- Each Postgres copy publishes those descriptions as native table and column comments.
- Inferred columns and explicit columns keep the descriptions of their fields. A column that the copy leaves out gets no comment.
- The table comment tells the meaning of the source record apart from the modes of the copy: the extraction and load modes, an append history where source identities can repeat, and the keys and conflict rules of deduplication.
- Text from a file names its parser. A column of an original file tells of its UUID and of the chunk table that holds the bytes.
- `loaded_at` tells of the load that last wrote the row. It does not tell of a change in the source or of the health of a sync.
- The first commit of a stream writes the comments, and each later load replaces them. A property description that you remove clears its old column comment.
- Descriptions must be strings with no NUL and no malformed Unicode. The destination checks them before it opens storage. The native `format` of Postgres quotes the names and the text.
- Read comments with `obj_description` and `col_description`, or with a catalog view over them.
- A view that changes the meaning of a field must describe that new meaning itself.
- The status of a sync and the coverage of an extraction are data of the run, not comments of the schema.

## Locks and commits

A run holds one connection to the schema and takes no lock. Loads into one schema run side by side, and a [checkpoint store](#checkpoints) keeps two runs of one copy apart. See [ADR 0003](./docs/adr/0003-a-load-takes-no-schema-lock.md).

- Postgres refuses two sessions that make one schema or one table at the same moment. Thus the first commits of the tables of one schema take turns for the DDL that they share: the schema and `_elt_writers`. The schema is made in a transaction of its own, which begins only when the lock of the schema is held, because a transaction that waits for an advisory lock does not see the catalog changes that it waited for. Connections that load into one schema can start together.
- As in the Postgres destination of Airbyte, no transaction stays open between commits. Thus the read of the source holds no locks on the targets and keeps nothing from vacuum, however many tables a run loads. See [ADR 0002](./docs/adr/0002-no-transaction-stays-open-between-commits.md).
- The prepare of a stream only checks the stored table and makes its stage. Thus a run that fails before the first commit of a stream leaves nothing of that stream.
- Each stream stages its operations in a `TEMP` table that only its session sees, and commits them at its own checkpoints. Each commit is one short transaction.

Each commit:

- Operations get to the stage in batches of at most 1000 rows or 16 MiB. Each batch goes as one JSON parameter and is cast for each column, so large text and binary values travel a few at a time.
- A record that is too large to send alone, past the longest string of V8 or the largest message of Postgres (1 GB), fails its stream. The error names the table, its largest column and its key.
- Original files wait in a chunk table that only the session sees, until the commit moves them.
- The first commit of a stream makes its table, comments, index and reader view, and records its writer.
- A commit merges the stage of one stream into its table. The result is the same as when the operations apply one at a time: staged `DELETE`s remove their keys, only the records after the last `DELETE` of a key count, `replace` keeps the last record, and `cursor_newer` keeps the first record with the greatest cursor. Text cursors compare by bytes (`COLLATE "C"`).
- Each row has `loaded_at` (`TIMESTAMPTZ`), the time on the clock of the pipeline when the load that wrote its values opened. A deduplicating load or an overwrite that brings the same values again leaves the row, its `loaded_at` and its `committed_in` as they are.
- Each row has `_elt_row_hash` (`TEXT`), the SHA-256 of its values, which the load computes as it stages the row. A null value does not count, so a column that the stream adds makes no new version. A stored file counts as the SHA-256 of its bytes, not as its UUID.
- Each row has `committed_in` (`INTEGER`), the number of the commit that last wrote it. See [commit numbers and positions](#commit-numbers-and-positions).
- An overwrite replaces the rows of the table by difference, with `DELETE`, not `TRUNCATE`, at the commit of its stream: each stored row that no staged record matches by `_elt_row_hash` goes, each record that no row matches enters, and each row that matches stays as it is. Two identical rows match as a multiset, so a keyless overwrite that sends one of them again removes only the other. The exclusive lock of `TRUNCATE` would block readers until the commit ends. Until then, readers see the earlier load. A [reset](../../elt/README.md#resets) deletes its scope in the same way. See [ADR 0004](./docs/adr/0004-an-overwrite-deletes-rows-and-does-not-truncate.md).
- Deduplication upserts on a unique index that is named after the table and the key (`_elt_dedup_<hash>`). Postgres makes the index one time, and makes it again only when the key changes. A load that replaces the rows makes the index after it removes the rows that leave.
- The writer of each table is in `<schema>._elt_writers`, by the [target ownership](../../elt/README.md#target-ownership) rule.

Shape changes:

- When the columns, types or `NOT NULL`s of a stored table do not fit the stream, the load [evolves it](../../elt/README.md#shape-changes) in place before it reads, as the Postgres destination of Airbyte does. `ALTER TABLE` adds a nullable column, drops a column that the stream dropped (with its chunk table, for a file column), and converts a column with a new type `USING column::type`. Before the conversion, each stored value that is not null must cast back to itself (`column::type::old IS DISTINCT FROM column` finds none), so `1.5` in `double precision` fails the load to `bigint`, naming the column, and `2` converts. A conversion from `text` is the parse that the load applies to each new value, so the conversion itself refuses a value it cannot parse. It keeps `NOT NULL` and the primary key on the explicit key columns of the target, and moves the key when they change. The reader view is made again over the result.
- The change waits at most 3 seconds for readers to let go. Otherwise it fails the copy until the next run.
- A value that does not convert, or rows that repeat a new key, fail the change. The table stays as it was.
- The views that read the table, its history or its reader view, also views that elt did not make, read the table again after the change, with their owners, options, comments and privileges. A view that does not fit the change, such as one that reads a column that the change drops, fails the change, and the error names the view. See [ADR 0006](./docs/adr/0006-a-change-of-a-table-makes-the-views-over-it-again.md).
- A [reset](../../elt/README.md#resets) of the full stream, or an overwrite whose stored table does not fit, reloads into a hidden table `_elt_next_<hash>`. The first commit of the reload makes it. When the stream ends with no failure:
  - If the stored table still has the stream's shape, the load changes it in place, by difference: each row that the hidden table has again stays, with its commit and its `loaded_at`; each other row goes into the history; and each new row enters. The table keeps its indexes, its triggers and the views that depend on it.
  - If not, the load swaps the hidden table in, also with a wait of at most 3 seconds, and drops the chunk table of a file column that it does not have now. The history keeps every row of the old table. The swapped-in table and its reader view keep the privileges of the old ones, and the views over them read the new table, as for a change of shape.

## Commit numbers and positions

Each commit has a number. One numbering orders the commits of every schema of the database, so a reader such as eca reads the whole warehouse at one position, as a Kafka consumer reads up to the last stable offset.

- The numbering is in the schema `_warehouse`, beside the [sync history](#sync-history). The first load or clear in the database makes it. It takes the same lock as the sync history, because Postgres refuses two sessions that make one schema at the same moment. Thus first loads into many schemas can start together.
- `_warehouse._elt_commits` has one row for each commit: its `number`, its `load` and its `committed_at`. The sequence `_warehouse._elt_commit_numbers` gives the numbers. A commit takes its number at its start, so two commits that run at the same time can end in a different order than their numbers.
- `_warehouse._elt_loads` has one row for each load: its `connector` (the name of the connection) or its `dataset` (the name of a computed dataset), its `opened_at`, and its `closed_at`, which is null while the load is open. A load of a connection opens when a pass starts to load, and closes when the pass ends; a load of a dataset is one refresh. When a load opens, it closes each load of the same connector or dataset that is still open: the process of that pass or refresh ended first, for example because it was killed. A closed load cannot commit: a commit locks the row of its load (`FOR SHARE`), so a close at the same time waits for the commit, or makes it fail.
- A clear that empties a table is a load of one commit, in the same transaction. It does not close the open loads of its connector.
- A commit into a [hidden table](./CONTEXT.md) shows nothing to readers. When the stream ends, one more commit gives the rows to the table with its number, and readers see them from that commit on.
- A change of shape that casts a column or drops one with values is a commit of the load too. The history keeps each row that it changes, as it was, and the row hash of the row becomes null, so the next record of the row writes it again. A change of type that the history cannot follow by a [widening](./CONTEXT.md) is a commit of the load too, even when it changes no row.
- `_warehouse._elt_epoch` keeps the epoch, an id that names the numbering, and `min_valid`, the oldest commit that a reading can read as of. A new database, or a database whose `_warehouse` was dropped, starts a new epoch, with `min_valid` 0.
- `await destination.positions(after?)` gives the positions of the database after the position `after`, in ascending order, or all positions. A position is `<epoch>:<number>`. It names the last commit of a closed load, when no other load has commits before and after it, so a reader there sees no part of a pass in any schema. The list starts at `min_valid`. When `after` is of a different epoch, is after the newest settled commit, or is before `min_valid`, it gives `{ expired }` with the reason. A string that is not a position throws a `TypeError`. A database with no numbering has no positions.

How a reader knows which numbers are done:

- Commits run side by side, so a number can still be in flight while a higher one has committed. Each commit holds a transaction lock on its number (`pg_advisory_xact_lock`) until it ends. The newest settled commit is the highest number below the first number whose lock is still held. Numbers of commits that rolled back are gaps that the reader skips. This is the high-water mark of event stores, and no commit waits for another.
- Postgres releases the locks of a transaction after its commit is visible to new snapshots. Thus the reader finds the high-water mark first, and then reads `_elt_commits` and `_elt_loads` in a `REPEATABLE READ` snapshot. `pg_locks` is not part of a snapshot, so the other order could show a commit at or below the mark that the snapshot does not see.
- A commit takes its number and then its lock, in two steps. A reader that looked between them would pass the number. Thus each commit holds a shared lock (`pg_advisory_lock_shared`) across the two steps, and a reader holds the same lock alone while it reads the last number taken and the locks held. This is a readers–writer lock with the commits as the many readers.

The history of a table:

- `<schema>._elt_history_<hash>` keeps each row that a commit replaced or removed, with `replaced_in`, the number of that commit, as a SQL Server temporal table keeps its history beside the current table. The writes that keep rows are a deduplicating upsert that changes the values (behind the same cursor guard), a staged `DELETE`, the end of the reload of a reset partition, an overwrite, a reload, and a change of shape. `<schema>._elt_reloads` names the partitions of each open reload of a reset partition. A write into a hidden table keeps nothing, because no reader saw its rows.
- `clear()` forgets the rows that it removes. Its commit C sets `min_valid` to C, if it is higher, with `expired_by` `clear`, and the history of the cleared table deletes each of its rows, with the stored files that only they refer to. A reading or `positions(after)` before C gives `{ expired }`, with the reason that a clear forgot the rows of its table. The history of another table keeps its rows with `replaced_in <= C` until its next commit or the retention deletes them; a reading skips them, as for a change of type.
- Each column of the history has the type of the table's column of the same name. It takes each new column of the table. A column that the table drops stays in the history with its last type.
- When a change of shape, or the swap of a reload, gives a column of the table another type, the history changes the type of its column in the same commit. This includes a column that the table dropped and a later change adds back with another type. Delta Lake, Iceberg, BigQuery and Snowflake change a type in place only when the change is a widening, and they read the past with its own schema, which one Postgres view cannot do. The destination follows the same rule:
  - A widening maps each old value to one new value exactly, with no loss: any type to `text`, `bigint` to `numeric`, `date` to `timestamp without time zone`, and an array whose item widens. The history casts its column with the same cast (`USING column::type`), and each position stays readable.
  - Any other change, such as `text` to `bigint`, or `double precision` to `bigint`, acts as a rewrite. `bigint` to `double precision` is not a widening, because above 2^53 it loses digits. The commit E of the change sets `min_valid` to E, if it is higher. The history of the table deletes each row with `replaced_in <= E`, which only positions before E read, together with the stored chunks that only those rows refer to, and then casts its column. A reading or `positions(after)` before E gives `{ expired }`, with the reason that a commit changed the type of a column. Each position from E on reads exactly. The history of other tables keeps its rows with `replaced_in <= E` until a retention deletes them.
- A file that a row of the history refers to stays while the row stays: its chunks, or its file in a file storage (`.store(files)`).

Retention:

- `new PostgresDestination({ url, schema, retention })` sets how long the history keeps a position readable, as a `Temporal.Duration`: 30 days unless set, as Delta Lake keeps its log. A negative one throws a `RangeError`.
- When a commit takes its number, let W be the newest position at or below the newest commit older than the window. The commit sets `min_valid` to W, if it is higher. W is a position, not a commit, so a pass that stays open longer than the window keeps the position before it readable.
- When the commit moves `min_valid`, it also deletes each row of `_warehouse._elt_commits` with a number less than W, and each closed load of `_warehouse._elt_loads` that has no commit left. W is a position, so each load with a commit before W ends at or before W. The row of W stays, because a reading as of W gives its `committed_at`. A `committed_in` of a row is only compared with numbers, so it needs no row in `_elt_commits`. An open load stays, also when it has no commit yet. The row of `_elt_epoch` stays locked until the commit ends, so a commit at the same time that read an older `min_valid` does not move it back.
- In the same commit, the writer deletes each row of its table's history with `replaced_in <= min_valid`, and then the chunks that no row of the table or of its history refers to. The history of another table deletes its rows at that table's next commit; until then a reading skips them, because no position at or after `min_valid` reads them.
- A reading or `positions(after)` before `min_valid` gives `{ expired }`, with the reason that names the retention, or the change of type, that set it last.
- One numbering serves every destination of the database, so the shortest retention among them decides for all readers.

A reading as of a position:

- Each [reader view](#reader-views) reads its table as of the position that its transaction sets in `elt.position`: the rows of the table with `committed_in <= P`, and the rows of the history with `committed_in <= P < replaced_in`. A session that sets nothing reads the table as it is now, and no row of the history. A view built on a reader view, such as a [view](#declare-a-view) in `marts` or a view of the host in another schema, reads as of the same position. A read makes no object.
- `await destination.reading(position?)` opens its own session and gives `{ sql, position, at }`, or `{ expired }`. Dispose it with `await using` to end the session. It takes the high-water mark, then begins `REPEATABLE READ READ ONLY`, so no commit after it opens shows. With no position, it reads the newest position. Below the newest commit that its snapshot sees, it sets `elt.position` for its transaction. `at` is when the commit of the position was made.
- A position of a different epoch, past the newest settled commit, or before `min_valid`, gives `{ expired }`. A number that is not a position, such as a commit inside a pass, and a string that is not a position, throw a `TypeError`.
- The [sync history](#sync-history) keeps no row versions. A reading below the newest commit fails each of its views in `marts`, with the message that it cannot be read as of a position. The tables in `_warehouse` read as they are now.
- A table with no reader view reads as it is now. Read through the reader view.

## Checkpoints

`PostgresCheckpointStore({ url, schema })` keeps the checkpoints in `<schema>._elt_checkpoints`, beside the data. See [ADR 0001](./docs/adr/0001-checkpoints-are-kept-beside-the-data.md).

- The columns are `id`, `binding`, `reloading` and `state`. `binding` and `state` are `JSON`, which keeps state that `JSONB` would refuse, such as `\u0000` and lone surrogates.
- `DROP SCHEMA … CASCADE` resets the data and the checkpoints together.
- The store takes a session advisory lock for each copy `id`, on its own connection, in sorted order. Different IDs run in parallel. A run that finds one ID in use releases the IDs that it took and fails with `Checkpoint <id> is in use by another run`.
- Each save autocommits, so no checkpoint transaction stays open while the load runs.
- The store makes the schema and the table in their own committed transaction, under the lock of the schema. Thus two runs that make them at the same time take turns.

## Reader views

`table.withReaderView(schema, name)` returns the same target. A load also shows it as the view `schema.name`, with the external schema of the stream, its columns and `loaded_at`, and with the comments of the table.

- `committed_in`, `_elt_row_hash` and `replaced_in` are internal: only the SQL of the destination reads them, for the history, the retention, the readings and the difference. The reader view does not show them, now or as of a position. Thus a column that the destination adds for itself changes nothing that a reader sees, as SQL Server hides the period columns of a temporal table that it marks `HIDDEN`. The raw table shows them; readers do not query it.

- The load makes the view in the same commit as its table, so the view exists when the table exists. It follows inserts, updates and deletes, and it is not made again for them.
- The stream needs a JSON Schema `description`, and each column needs one too. File columns and `loaded_at` bring their own, and so does `committed_in` of the raw table. A missing description fails the declaration of the copy before a connection reads.
- The schema must exist. In the [warehouse](../../../infra/README.md), `marts` is part of the contract of the reader, and default privileges make the view readable.
- A load never replaces a view that exists, because a replace of a view that readers can see would lock them out. It only writes the comments again, which does not block readers.
- A relation with the name of the view that is not a view of the table, or that has different columns, is refused before the load reads. The error names it.
- A table that evolves or reloads gets its view again, as [above](#locks-and-commits).
- The view reads its table and the [history](#commit-numbers-and-positions) of the table as of a position. Each column of the history has the type that the column of the table has now, so the view reads it with no cast.

## Declare a view

```ts
import { PostgresDestination, View } from '@eltjs/elt-postgresql';

const marts = new PostgresDestination({ url, schema: 'marts' });

const unread = new View({
  into: marts,
  name: 'unread_count',
  description: 'How many messages each chat has that the user did not read.',
  columns: {
    chat: 'The chat.',
    n: 'Number of messages that the user did not read.',
  },
  sql: 'SELECT chat, count(*) AS n FROM messages WHERE read = 0 GROUP BY chat',
});
```

Give the view to the pipeline in `derived`. The view is `marts.unread_count`: it lives in the schema of `into`, and the bare names of its SQL, such as `messages`, are found in that schema too. Name a relation of another schema with its schema, such as `raw.raw_messages`.

- A view names no inputs. Its SQL reads them, as in [elt-sqlite](../sqlite/docs/adr/0001-a-view-names-no-inputs.md).
- The view appears when its query compiles. Thus a reader never finds a view that fails.
- While the SQL reads a raw table or a reader view that a copy of the pipeline has not made yet, the view waits. It appears at the refresh after that copy loads. Postgres tells which relation is missing (`42P01`), and the view waits only when the pipeline makes that relation.
- While the SQL reads a view or a computed dataset that comes before it in `derived` and that still waits, the view waits too, as dbt skips a model whose upstream model was skipped.
- While a view waits, its schema has no view of its name: the refresh drops the view that an earlier declaration made with `DROP VIEW IF EXISTS ... CASCADE`, as dbt's `postgres__drop_view` does. Each view over it goes too: a view of the pipeline waits or is made again by its own refresh, and a view that someone made over it must be made again.
- Any other error of the query, for example a misspelled table, is a dataset failure. It fails the run with the error of Postgres.
- The columns must be the same as the columns that the query gives. `marts.catalog` lists them with their descriptions when the view is in `marts`.
- A refresh that changes nothing leaves the view as it was. The refresh makes the query in a savepoint and compares its definition with the stored one, so the view keeps its OID, its grants and its readers.
- A changed declaration replaces the view in one transaction. The views that read it, also views that elt did not make, read the new view, with their owners, comments and privileges ([ADR 0006](./docs/adr/0006-a-change-of-a-table-makes-the-views-over-it-again.md)). The view keeps its own privileges.

## Declare a computed dataset

```ts
import { DocumentText } from '@eltjs/elt';
import { ComputedDataset } from '@eltjs/elt-postgresql';

const text = new ComputedDataset({
  into: marts,
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

`documents` is the target of a copy, and `from` can name more than one. The rule reads each row that those copies loaded, through the reader view of a target that has one. `from` can also name a `View` that comes before the computed dataset in `derived`. See [Write a rule](../../elt/README.md#write-a-rule) in elt.

A computed dataset keeps one output row for each key, in the table `raw_<name>` in the schema of `into`, beside its history. Readers query the view `<name>` in the same schema. Its columns are the same as in [elt-sqlite](../sqlite/README.md#declare-a-computed-dataset): the key, `input_hash`, `rule`, `status` (`computed`, `empty` or `failed`), `error`, and the columns of the rule. A `text` column of a rule is `TEXT`, a `blob` column is `BYTEA`, and an `integer` column is `BIGINT`. A `vector` column is `BYTEA` that holds the bytes of `toSql` of `@zukhruf/vectors/sqlite`, float32 values little-endian, as in elt-sqlite; `fromSql(Vector, bytes)` of the same package reads them back. The driver `postgres` gives a `BIGINT` as a string by default.

At each refresh, the computed dataset compares the inputs with the output rows:

- It computes each key that is new, or whose input or rule identity changed. The refresh after the passes also computes each key whose status is `failed`, once for each pass.
- It deletes each output row whose key no input has any more.
- It keeps an output row when the rule stops handling its input.
- Each call of the rule commits as it settles, so readers see the output rows as they land. The calls run side by side; their commits take turns on the one session of the refresh.
- When the declaration of the raw table changes, the refresh makes the table again. The history keeps each row of the old table, and the views over the dataset read the new one.

A refresh is a load in `_warehouse._elt_loads`, under the name of its dataset, so a [reading](#commit-numbers-and-positions) shows the computed dataset as of a position:

- Each transaction of the refresh that changes a row takes one commit number. A transaction that changes no row takes none. No commit inside a refresh that is open is a position.
- The raw table has `committed_in` and `_elt_row_hash` after the columns of the rule. The view `<name>` does not show them, and it reads as of the position of its reading, as a reader view does. A computed dataset has no `loaded_at`.
- A rule column cannot have the name of the key, of an engine column, of `committed_in`, `_elt_row_hash` or `replaced_in`. The constructor refuses such a rule with a `TypeError` that names the column and the dataset.
- When the rule makes a row again with the same values, for example a `failed` row that fails again with the same error, the row stays as it is, with its commit.
- Before a commit changes or deletes an output row, it copies the row into the history of the raw table.

## When something fails

- **A rule failure** gives an output row with the status `failed` and the reason in `error`. The run continues, and the refresh after the next pass tries the input again.
- **A dataset failure**, for example a query that Postgres refuses, rejects the run, or it stops the watch, with a `DerivedDatasetError` that names the dataset.
- **A table that is gone**, for example one that a person dropped by hand, is no failure. A computed dataset that reads it waits and keeps its output rows. When the copy loads the table again, the dataset asks the rule only for inputs that changed.
- **A copy that failed** keeps its last committed rows. The derived datasets read those rows.

## Sync history

`PostgresSyncHistory({ url })` is the [sync history](../../elt/README.md#sync-history) of a pipeline that loads into Postgres. Use the same database for the history and the destinations of the connections.

- It records only connections with a Postgres destination. It refuses other connections when the pipeline validates.
- It records into `_warehouse.sync_attempts`, `_warehouse.extraction_coverage` and `_warehouse.stream_checks`. The last one holds the latest check of each stream by a watch that found it unchanged.
- `install()` makes those tables and `_warehouse.derived_status`, and publishes the `marts` views `sync_attempts`, `extraction_coverage`, `sync_status`, `stream_status`, `derived_status` and `catalog`, in one transaction. The pipeline calls it before each run and watch, and it is safe to repeat. See [ADR 0005](./docs/adr/0005-the-history-install-publishes-the-catalog.md).
- `new PostgresSyncHistory({ url, readers: ['agent_reader'] })` names the roles that read the database as of a position with their own session: `new PostgresDestination({ url: readerUrl, schema })`, then `positions()` and `reading()`. Each install grants each reader what a reading needs, which is the numbering in `_warehouse` and nothing else of it, as dbt applies the grants that a model declares after each build. Thus no host names the objects of the numbering, and a reader keeps its grants when the numbering is made again. The install grants nothing else: who may read `marts` is a grant of the database, such as its default privileges. A role that does not exist fails the install.
- Before a pass reads, the history inserts one `sync_attempts` row, with the connection name as `connector` and the source identity as `source`. It inserts one `extraction_coverage` row for each selected stream, with the declared `coverage(stream)` of the source and the schema of the destination as `target_schema`. The outcomes close them.
- A run declares each stream that a connection selected. A watch pass reads only the streams whose change signals changed, so an attempt vouches only for its own `extraction_coverage` rows.
- A connection that is not valid or that stopped, a failed change signal and a failed upkeep each record a failed attempt with no outcomes.
- Each attempt has a session of its own until its pass ends, and that session holds a lock on the attempt. A pass whose process stopped, for example a container restart, stays `running` until the next attempt of its connection begins. That attempt records it as `failed`, because no session holds its lock. The pipeline records a failed change signal while a pass of the same connection runs, and the running pass stays `running`. No host option is necessary, because Postgres knows which sessions are alive. See [ADR 0009](./docs/adr/0009-a-running-attempt-holds-a-lock-of-its-session.md).
- `_warehouse` tables are made only when they are missing.
- `readPassStatus(url)` gives the latest pass of the database and the latest outcome of each stream, as `readPassStatus(path)` of elt-sqlite gives them for a file. The latest passes of the connections show as one pass. It is `running` when one connection runs. Else it is `cancelled` when one pass stopped, `succeeded` when all passes succeeded, `failed` when all passes failed, and `partial` in all other cases. It starts with the first pass and completes with the last. Its error has the error of each pass that did not succeed, one on each line. Its failure type is `config` when one pass has a `config` failure. Its last success and its `current_as_of` are the earliest of the passes, or null when one pass has no value. Each stream has the error of its latest attempt when its copy failed or was partial in that attempt: the error of each failure, one on each line. Times are ISO text. A database with no sync history gives no pass and no streams. It reads `marts`, so a reader role that may read `marts` can call it with its own URL.

The relations in `marts`:

| Relation              | Contents                                                                                                                                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog`             | Each view and column in `marts`, with its description. The start point of a reader. A table is not for readers, also when it is in `marts`, such as the raw table of a computed dataset.                                                                                                 |
| `sync_status`         | For each connection: the latest attempt, the end of the last successful pass, and `current_as_of` (the oldest of its streams).                                                                                                                                                           |
| `stream_status`       | For each connection and stream: the latest attempt that declared the stream with the status of its copy, and the last attempt in which that copy succeeded. A watch pass reads only changed streams, so judge a stream here, by `current_as_of`.                                         |
| `derived_status`      | For each view and computed dataset, named with its schema: whether it waits for its inputs, refreshes, is current or failed, its `as_of`, and for a computed dataset how many inputs it computed, found empty, failed on or has still to compute. See [derived status](#derived-status). |
| `sync_attempts`       | The kept history of attempts, with start and end times, status and errors.                                                                                                                                                                                                               |
| `extraction_coverage` | For each attempt and stream: the configured selection, the explanation of the scope, the target, the outcome of the copy, the committed counts and the failed partitions.                                                                                                                |

What the relations tell:

- Each attempt keeps its own declarations.
- `sync_status` gives the latest attempt apart from the most recent attempt in which all copies succeeded. `stream_status` gives the same two facts for each stream, because a watch pass declares only the streams that changed.
- A pass with no change moves the success forward, also with zero writes.
- A failed or partial pass keeps the earlier success, and its scope stays available by the attempt ID.
- The status of each copy and the failed partitions let a reader find the streams that succeeded in a partial attempt.
- The counts are the accepted operations that the pass committed, also deduplication no-ops and deletions of keys that were not there. They are not counts of changed rows or totals.
- A first failure has no time of success.
- Coverage is the [configured scope](../../elt/README.md#coverage). Judge freshness by `current_as_of` ([the four clocks](../../elt/README.md#the-four-clocks)).

## Derived status

Each [view](#declare-a-view) and [computed dataset](#declare-a-computed-dataset) keeps one row in `_warehouse.derived_status`, which readers see as `marts.derived_status`. A reader needs it because `sync_status` says that a pass succeeded while a computed dataset still computes, or failed on each of its inputs.

- A refresh writes `waiting` when a relation that the dataset reads is not made yet, and `refreshing` when it begins, with `refreshing_since`. A computed dataset also writes how many inputs it read and how many it has still to compute (`pending`). Each commit of the refresh lowers `pending` in its own transaction, so a reader sees it fall while the rows land.
- A refresh that ends with no failure of the dataset writes `current`, with `as_of`, when it began to read, and `refreshed_at`. A refresh that fails writes `failed`, with `error`. A rule that fails on one input is not a failure of the dataset: `failed` counts its rows.
- `computed`, `empty` and `failed` count the output rows when the refresh began and when it ended.
- A dataset is caught up when its `state` is `current`, its `pending` is 0, and its `as_of` is at or after the start of the last pass of the connections that it reads. This is the frontier of Materialize and the `DATA_TIMESTAMP` of a Snowflake dynamic table, with the pending items of a pgai vectorizer.
- A refresh that a stopped process left stays `refreshing` until the next refresh. The status keeps no row versions, so a reading as of a position fails the view, as it fails the other views of the sync history.
- A status write takes no commit number: it is not data of a position.

## Decisions

- [ADR 0001](./docs/adr/0001-checkpoints-are-kept-beside-the-data.md): checkpoints are kept beside the data.
- [ADR 0002](./docs/adr/0002-no-transaction-stays-open-between-commits.md): no transaction stays open between commits.
- [ADR 0003](./docs/adr/0003-a-load-takes-no-schema-lock.md): a load takes no schema lock.
- [ADR 0004](./docs/adr/0004-an-overwrite-deletes-rows-and-does-not-truncate.md): an overwrite deletes rows and does not truncate.
- [ADR 0005](./docs/adr/0005-the-history-install-publishes-the-catalog.md): the history install publishes the catalog.
- [ADR 0006](./docs/adr/0006-a-change-of-a-table-makes-the-views-over-it-again.md): a change of a table makes the views over it again.
- [ADR 0007](./docs/adr/0007-readers-are-named-on-the-sync-history.md): readers are named on the sync history.
- [ADR 0008](./docs/adr/0008-derived-datasets-follow-elt-sqlite.md): derived datasets follow elt-sqlite.
- [ADR 0009](./docs/adr/0009-a-running-attempt-holds-a-lock-of-its-session.md): a running attempt holds a lock of its session.
- [ADR 0010](./docs/adr/0010-readers-look-in-marts-and-elt-keeps-its-tables-in-warehouse.md) (proposed): readers look in `marts`, and elt keeps its tables in `_warehouse`.

## Development

Run the commands from the workspace root. The tests start their own Postgres in Docker through `Postgres` of `@zukhruf/testing/postgres`.

```sh
npx nx run elt-postgresql:test        # builds, then runs the tests
npx nx run elt-postgresql:typecheck   # formats, lints, then type checks
npx nx run elt-postgresql:build       # compiles src/ to dist/
```

```
src/
  postgres-destination.ts         PostgresDestination: tables and the load
  postgres-writer.ts              the stage, the commit, evolve and reload of a table
  postgres-column.ts              the type of each column
  postgres-reader-view.ts         the reader view of a table, as of a position
  postgres-history.ts             the history of a table, and the row hash
  postgres-numbering.ts           commit numbers, loads and positions
  postgres-as-of.ts               a reading of the database as of a position
  view.ts                         View
  computed-dataset.ts             ComputedDataset
  postgres-views.ts               the publication of views, for View and the sync history
  postgres-dependents.ts          the views over a table, made again over its change
  postgres-privileges.ts          the privileges of a relation, kept across its change
  postgres-derived-status.ts      the status that each derived dataset keeps of itself
  postgres-checkpoint-store.ts    PostgresCheckpointStore
  postgres-sync-history.ts        PostgresSyncHistory and the catalog
  postgres-sync-history-schema.ts the tables and views of the history
```
