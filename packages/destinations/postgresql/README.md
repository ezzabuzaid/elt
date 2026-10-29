# @workspace/elt-postgresql

The Postgres destination of elt. It loads each table of a connection into one schema of a Postgres database, with typed columns, and it does not block readers while it loads. It can keep a reader view of each table in a different schema, such as `marts`, and it publishes documented SQL views that the application defines. It also has a checkpoint store and a sync history that keep their data in the same database.

This README tells about the Postgres destination. The pipeline itself is in [elt](../../elt/README.md). The database of the repository, its roles and its `marts` schema are in [infra](../../../infra/README.md).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md), and the glossary of [elt](../../elt/CONTEXT.md) for the words of all of elt.

## Load a stream into Postgres

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@workspace/elt-postgresql';

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
- The URL holds credentials, so it stays private: `location()` names only the schema and the table.
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

- Postgres keeps time to the microsecond. A time with more fraction digits, such as the `datetime2(7)` of SQL Server, stays exact text. It sorts in time order, because each value of the column has the same width. Cast it (`::timestamp`) for date arithmetic, which rounds.
- A `TIMESTAMPTZ` keeps the instant. It does not keep the offset that the value had.
- Arrays keep the order of their elements, and load a JSON `null` as SQL `NULL`. Readers use `= ANY(...)`, `unnest()` and `cardinality()`. `marts.catalog` shows the type of the element.
- ISO dates count years astronomically, and Postgres does not. Thus the year `0000` loads as `0001 BC`, which is the same day. Each other year is written as it is given.
- Explicit columns are `columns.text`, `integer`, `real`, `boolean`, `date`, `timestamp` and `blob(field)`, with `.notNull()` and `.primaryKey()`.
- A plain `blob()` stores `BYTEA`. `blob().from(file)` keeps the original file in chunk tables, and `text().from(file).parse(parser)` stores the parsed text as `TEXT`. See [file bytes in the database](#file-bytes-in-the-database).
- Table, view and column names follow the [naming rule](../../elt/README.md#names). Postgres compares names with their case, keeps 63 bytes of a name, and reserves `loaded_at` and the system column names `xmin`, `xmax`, `cmin`, `cmax`, `ctid` and `tableoid`.

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

- Postgres refuses two sessions that make one schema or one table at the same moment. Thus two first loads into a new schema that start together can fail one time. No host starts them in that way.
- As in the Postgres destination of Airbyte, no transaction stays open between commits. Thus the read of the source holds no locks on the targets and keeps nothing from vacuum, however many tables a run loads. See [ADR 0002](./docs/adr/0002-no-transaction-stays-open-between-commits.md).
- The prepare of a stream only checks the stored table and makes its stage. Thus a run that fails before the first commit of a stream leaves nothing of that stream.
- Each stream stages its operations in a `TEMP` table that only its session sees, and commits them at its own checkpoints. Each commit is one short transaction.

Each commit:

- Operations get to the stage in batches of at most 1000 rows or 16 MiB. Each batch goes as one JSON parameter and is cast for each column, so large text and binary values travel a few at a time.
- A record that is too large to send alone, past the longest string of V8 or the largest message of Postgres (1 GB), fails its stream. The error names the table, its largest column and its key.
- Original files wait in a chunk table that only the session sees, until the commit moves them.
- The first commit of a stream makes its table, comments, index and reader view, and records its writer.
- A commit merges the stage of one stream into its table. The result is the same as when the operations apply one at a time: staged `DELETE`s remove their keys, only the records after the last `DELETE` of a key count, `replace` keeps the last record, and `cursor_newer` keeps the first record with the greatest cursor. Text cursors compare by bytes (`COLLATE "C"`).
- Each row of a run has the same `loaded_at` (`TIMESTAMPTZ`).
- An overwrite empties the table with `DELETE`, not `TRUNCATE`, at the commit of its stream. The exclusive lock of `TRUNCATE` would block readers until the commit ends. Until then, readers see the earlier load. A [reset](../../elt/README.md#resets) deletes its scope in the same way. See [ADR 0004](./docs/adr/0004-an-overwrite-deletes-rows-and-does-not-truncate.md).
- Deduplication upserts on a unique index that is named after the table and the key (`_elt_dedup_<hash>`). Postgres makes the index one time, and makes it again only when the key changes. A load that replaces the rows makes the index after it empties the table.
- The writer of each table is in `<schema>._elt_writers`, by the [target ownership](../../elt/README.md#target-ownership) rule.

Shape changes:

- When the columns, types or `NOT NULL`s of a stored table do not fit the stream, the load [evolves it](../../elt/README.md#shape-changes) in place before it reads, as the Postgres destination of Airbyte does. `ALTER TABLE` adds a nullable column, drops a column that the stream dropped (with its chunk table, for a file column), and converts a column with a new type `USING column::type`. It keeps `NOT NULL` and the primary key on the explicit key columns of the target, and moves the key when they change. The reader view is made again over the result.
- The change waits at most 3 seconds for readers to let go. Otherwise it fails the copy until the next run.
- A value that does not convert, rows that repeat a new key, or a view of a different schema built on the reader view fail the change. The table stays as it was.
- A [reset](../../elt/README.md#resets) of the full stream, or an overwrite whose stored table does not fit, reloads into a hidden table `_elt_next_<hash>`. The first commit of the reload makes it. When the stream ends with no failure, the load swaps it in, also with a wait of at most 3 seconds, and drops the chunk table of a file column that it does not have now. A view built on the reader view refuses the swap.

## Checkpoints

`PostgresCheckpointStore({ url, schema })` keeps the checkpoints in `<schema>._elt_checkpoints`, beside the data. See [ADR 0001](./docs/adr/0001-checkpoints-are-kept-beside-the-data.md).

- The columns are `id`, `binding`, `reloading` and `state`. `binding` and `state` are `JSON`, which keeps state that `JSONB` would refuse, such as `\u0000` and lone surrogates.
- `DROP SCHEMA … CASCADE` resets the data and the checkpoints together.
- The store takes a session advisory lock for each copy `id`, on its own connection, in sorted order. Different IDs run in parallel. A run that finds one ID in use releases the IDs that it took and fails with `Checkpoint <id> is in use by another run`.
- Each save autocommits, so no checkpoint transaction stays open while the load runs.
- The store makes the schema and the table in their own committed transaction, under the lock of the schema. Thus two runs that make them at the same time take turns.

## Reader views

`table.withReaderView(schema, name)` returns the same target. A load also shows it as the view `schema.name`, with the columns of the table and `loaded_at`, and with the comments of the table.

- The load makes the view in the same commit as its table, so the view exists when the table exists. It follows inserts, updates and deletes, and it is not made again for them.
- The stream needs a JSON Schema `description`, and each column needs one too. File columns and `loaded_at` bring their own. A missing description fails the declaration of the copy before a connection reads.
- The schema must exist. In the [warehouse](../../../infra/README.md), `marts` is part of the contract of the reader, and default privileges make the view readable.
- A load never replaces a view that exists, because a replace of a view that readers can see would lock them out. It only writes the comments again, which does not block readers.
- A relation with the name of the view that is not a view of the table, or that has different columns, is refused before the load reads. The error names it.
- A table that evolves or reloads gets its view again, as [above](#locks-and-commits).

## Documented views

`publishPostgresViews(transaction, { schema, views })` publishes normal SQL views with native view and column comments. Each `PostgresView` gives `name`, `query`, `description`, and `columns`, a map from the output column names to their descriptions. The application gives the SQL and the meaning. Postgres gets the output types.

With a `postgres` client `sql` and a table `raw.notes`:

```ts
import { publishPostgresViews } from '@workspace/elt-postgresql';

await sql.begin(async (transaction) => {
  await publishPostgresViews(transaction, {
    schema: 'knowledge',
    views: [
      {
        name: 'notes',
        query: 'SELECT id, title FROM raw.notes',
        description: 'One row per note, identified by id.',
        columns: {
          id: 'Source note identifier.',
          title: 'Note title.',
        },
      },
    ],
  });
});
```

- Give trusted SQL of the application as one query. Each output column must have one description, and no description can be empty. A query that adds a second statement fails.
- Names follow the limit of 63 bytes of the destination.
- The publisher makes the schema when it is not there. It takes the lock of the schema, so other publishers of that schema wait. It replaces only the views that you give.
- List each view after the views that it reads. The publisher drops the views in the reverse order and makes them in the given order.
- It never drops with `CASCADE`. A dependent view out of the list stops the publication.
- A savepoint restores the earlier views and comments on each failure, also when the caller catches the error and continues the transaction.
- An empty list does nothing.
- The caller owns the connection and the transaction. A replace makes the views again, so apply explicit grants again after the publication, in the same transaction. Default grants still apply.
- The application selects which content it shows. In the warehouse, default privileges on `marts` make each published view readable.
- `PostgresSyncHistory` uses this publisher for its views, and the Search Console views use it for their content.
- Views show the tables as the query reads them. A publication does not copy rows or start refreshes. Read their descriptions with `obj_description` and `col_description`, as for table comments.

## Sync history

`PostgresSyncHistory({ url })` is the [sync history](../../elt/README.md#sync-history) of a pipeline that loads into Postgres. Use the same database for the history and the destinations of the connections.

- It records only connections with a Postgres destination. It refuses other connections when the pipeline validates.
- It records into `_warehouse.sync_attempts`, `_warehouse.extraction_coverage` and `_warehouse.stream_checks`. The last one holds the latest check of each stream by a watch that found it unchanged.
- `install()` makes those tables and publishes the `marts` views `sync_attempts`, `extraction_coverage`, `sync_status`, `stream_status` and `catalog`, in one transaction. The pipeline calls it before each run and watch, and it is safe to repeat. It grants nothing. See [ADR 0005](./docs/adr/0005-the-history-install-publishes-the-catalog.md).
- Before a pass reads, the history inserts one `sync_attempts` row, with the connection name as `connector` and the source identity as `source`. It inserts one `extraction_coverage` row for each selected stream, with the declared `coverage(stream)` of the source and the schema of the destination as `target_schema`. The outcomes close them.
- A run declares each stream that a connection selected. A watch pass reads only the streams that its source reported changed, so an attempt vouches only for its own `extraction_coverage` rows.
- A connection that is not valid, or a connection whose watcher stopped, records a failed attempt with no outcomes.
- `_warehouse` tables are made only when they are missing.

The relations in `marts`:

| Relation              | Contents                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `catalog`             | Each view, table and column in `marts`, with its description. The start point of a reader.                                                                                                                                                       |
| `sync_status`         | For each connection: the latest attempt, the end of the last successful pass, and `current_as_of` (the oldest of its streams).                                                                                                                   |
| `stream_status`       | For each connection and stream: the latest attempt that declared the stream with the status of its copy, and the last attempt in which that copy succeeded. A watch pass reads only changed streams, so judge a stream here, by `current_as_of`. |
| `sync_attempts`       | The kept history of attempts, with start and end times, status and errors.                                                                                                                                                                       |
| `extraction_coverage` | For each attempt and stream: the configured selection, the explanation of the scope, the target, the outcome of the copy, the committed counts and the failed partitions.                                                                        |

What the relations tell:

- Each attempt keeps its own declarations.
- `sync_status` gives the latest attempt apart from the most recent attempt in which all copies succeeded. `stream_status` gives the same two facts for each stream, because a watch pass declares only the streams that changed.
- A pass with no change moves the success forward, also with zero writes.
- A failed or partial pass keeps the earlier success, and its scope stays available by the attempt ID.
- The status of each copy and the failed partitions let a reader find the streams that succeeded in a partial attempt.
- The counts are the accepted operations that the pass committed, also deduplication no-ops and deletions of keys that were not there. They are not counts of changed rows or totals.
- A first failure has no time of success.
- Coverage is the [configured scope](../../elt/README.md#coverage). Judge freshness by `current_as_of` ([the four clocks](../../elt/README.md#the-four-clocks)).

## Decisions

- [ADR 0001](./docs/adr/0001-checkpoints-are-kept-beside-the-data.md): checkpoints are kept beside the data.
- [ADR 0002](./docs/adr/0002-no-transaction-stays-open-between-commits.md): no transaction stays open between commits.
- [ADR 0003](./docs/adr/0003-a-load-takes-no-schema-lock.md): a load takes no schema lock.
- [ADR 0004](./docs/adr/0004-an-overwrite-deletes-rows-and-does-not-truncate.md): an overwrite deletes rows and does not truncate.
- [ADR 0005](./docs/adr/0005-the-history-install-publishes-the-catalog.md): the history install publishes the catalog.

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
  postgres-reader-view.ts         the reader view of a table
  postgres-views.ts               publishPostgresViews
  postgres-checkpoint-store.ts    PostgresCheckpointStore
  postgres-sync-history.ts        PostgresSyncHistory and the catalog
  postgres-sync-history-schema.ts the tables and views of the history
```
