# @eltjs/elt-sqlserver

> **Partly built, private.** Ezz accepted the design on 2026-11-19. The first steps of backlog #4736 are built: the append, overwrite and deduplicating writers, the numbering, the checkpoint store and the sync history (see "Built now" below). The rest of the "Now" column is design on paper until its step is built. The package is private until its tests pass for the whole design.

The SQL Server destination of elt. It loads each stream of a connection into a SQL Server or Azure SQL database, with typed columns, and it does not block readers while it loads. Each target is a reader view in `marts`, which the host names, over a raw table in `_warehouse`. It also keeps the views and computed datasets that the pipeline derives. A computed dataset can keep a vector column as a native `VECTOR(n)`, so Azure SQL searches it with `VECTOR_DISTANCE` or a DiskANN index. The checkpoint store and the sync history keep their data in the same database.

The destination gives the contract of [elt-postgresql](../postgresql/README.md): the same declarations, the same columns for readers, the same positions, history, retention and sync history. A host changes its destination and nothing else. Where SQL Server is different, this README says how and why ([ADR 0001](./docs/adr/0001-the-sql-server-destination-takes-the-declarations-of-elt-postgresql.md)).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md), and the glossary of [elt](../../elt/CONTEXT.md) for the words of all of elt.

## The map

| Now (first release)                                                                                                                                                                                                                                                              | Later                                                                                                                               | Never                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SqlServerDestination`: the four destination sync modes, evolve, reload, reader views, extended properties, file chunks                                                                                                                                                          | Native `VECTOR` over TDS, when tedious has it ([tedious #1841](https://github.com/tediousjs/tedious/pull/1841))                     | A search API in the destination: search is the host's SQL (`@zukhruf/vectors/sqlserver`)                                                             |
| Numbered commits, positions, history, readings, retention, a clear that forgets                                                                                                                                                                                                  | `float16` vector columns (`HalfVector`), for a model of more than 1,998 dimensions, such as `text-embedding-3-large` (3,072)        | System-versioned temporal tables as the history ([ADR 0001](./docs/adr/0001-the-sql-server-destination-takes-the-declarations-of-elt-postgresql.md)) |
| `View` and `ComputedDataset`, with `vector(n)` rule columns as `VECTOR(n)` and the statements of the host after each make of a raw table                                                                                                                                         | A bulk load through Azure Blob Storage and `BULK INSERT`, as the bulk mode of Airbyte, when a load is too slow through JSON batches | An ORM, or a query builder over the reader's SQL                                                                                                     |
| `SqlServerCheckpointStore`, `SqlServerSyncHistory` (with `derived_status`, `catalog` and named readers), `readPassStatus`                                                                                                                                                        | Microsoft Entra ID logins (managed identity), which `mssql` supports through `authentication`                                       | An `mssql://` URL                                                                                                                                    |
| The prerequisites in other packages: the `vector` rule column of elt, `dimensions` on `Embedding`, and the extraction of the rules that the destinations share ([ADR 0012](./docs/adr/0012-the-rules-that-the-destinations-share-move-into-elt-before-the-third-destination.md)) | SQL Server 2022 and older, which have no `VECTOR` and no `JSON` type                                                                | A migration of stored data between versions (elt AGENTS.md: stored data is disposable)                                                               |

### Built now

- `SqlServerDestination` with the four destination sync modes: the raw table with its `_elt_row` identity key (ADR 0003), the unique index on `_elt_key_hash` when the copy deduplicates or the columns declare a key (ADR 0004), the `MERGE` of a deduplicating commit (ADR 0005, see "Deduplication" below), the replacement by difference of an overwrite (see "Locks and commits" below), the history table, the `MS_Description` extended properties, the reader view, and `positions()`.
- The JSON batches through `OPENJSON` (ADR 0011), the check of the engine and the row versioning at each load (ADR 0010), the numbering with the rowversion of the commit row and the mark of the database copy (ADR 0002), and the clear that forgets.
- `SqlServerCheckpointStore` and `SqlServerSyncHistory`, with the application locks of ADR 0009.
- Not built yet: a reset and a reload (a `RESET` of the stream or of a partition, and an overwrite whose stored table no longer has the shape of its stream), evolve, file columns, `reading()`, `readPassStatus`, the writes of `derived_status`, `View` and `ComputedDataset`. A copy that needs one of them fails with a `TypeError`, and the package does not export the others yet.
- A failure of the setup of the database is a `SqlServerSetupError`. Its [failure type](../../elt/README.md#failure-types) is `config`. A login without a permission that a statement of the destination or of `SqlServerCheckpointStore` needs is also `config`: a `SqlServerPermissionError` of sdk-microsoft-sql-server, and the SQL Server errors 229 and 230 (a permission on an object or a column) and 262 (a permission in the database, such as `CREATE TABLE`). A login that the server refuses (`SqlServerLoginError`: wrong credentials, a disabled login, a database that it may not open) is `config` too, as a wrong password is in elt-postgresql. Each other error, for example a server that cannot be reached, is `system`.

## Load a stream into SQL Server

```ts
import { Connection, Copy, Pipeline } from '@eltjs/elt';
import {
  SqlServerCheckpointStore,
  SqlServerDestination,
  SqlServerSyncHistory,
} from '@eltjs/elt-sqlserver';

const login = {
  server: 'datahub.database.windows.net',
  database: 'semantic',
  user: 'elt_writer',
  password: '…',
};
const warehouse = new SqlServerDestination({ login });

await new Pipeline({
  history: new SqlServerSyncHistory({ login }),
  connections: [
    new Connection({
      name: 'sharepoint',
      source: sharepoint,
      destination: warehouse,
      checkpoints: new SqlServerCheckpointStore({ login }),
      steps: [
        new Copy(sharepoint.driveItems, warehouse.table('drive_items'), {
          id: 'sharepoint:drive-items',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        }),
      ],
    }),
  ],
}).run();
```

- `SqlServerDestination({ login })` loads into the database of the login. Each relation that readers query is a view in `marts`, and each table of elt is in `_warehouse`, as in Postgres ([elt-postgresql ADR 0010](../postgresql/docs/adr/0010-readers-look-in-marts-and-elt-keeps-its-tables-in-warehouse.md)). The first load makes the two schemas.
- `warehouse.table('drive_items')` names the reader view `marts.drive_items`, the reader name. The destination keeps the rows of the target in the raw table `_warehouse.raw_drive_items`.
- `login` is the parts of a login (`server`, `port`, `database`, `user`, `password`, `trustServerCertificate`) or an ADO.NET connection string, the two forms of `@eltjs/sdk-microsoft-sql-server`. The destination opens its sessions through the `SqlServerDatabase` of the SDK, which gets write sessions for it.
- The login holds credentials, so `location()`, which checkpoints keep, names only the raw table. A getter gives the login to the views and computed datasets of the destination, so JSON and `util.inspect` do not show it.
- The destination checks the declarations with no connection to the database.
- A reader name follows the [naming rule](../../elt/README.md#names), with the 128 characters of a SQL Server name. `table(name)` refuses a reader name that the sync history publishes in `marts`, such as `catalog`.
- The database must be SQL Server 2025 (17.x), Azure SQL Database or Azure SQL Managed Instance with the always-up-to-date policy, because the destination uses the `VECTOR` and `JSON` types. It must keep row versions for readers: `READ_COMMITTED_SNAPSHOT` and `ALLOW_SNAPSHOT_ISOLATION` on ([ADR 0010](./docs/adr/0010-a-reading-sets-its-position-in-the-session-context-and-reads-row-versions.md)). The first load checks both, and fails with the failure type `config` and the `ALTER DATABASE` statement that turns them on.
- The destination holds one connection of its own for each load, because a `#stage` table belongs to one connection. It does not take connections from a shared pool.

## The API

```ts
// @eltjs/elt-sqlserver
type SqlServerLogin =
  | string // an ADO.NET connection string
  | {
      server: string;
      port?: number;
      database: string;
      user: string;
      password: string;
      trustServerCertificate?: boolean;
    };

class SqlServerDestination extends Destination<SqlServerTable> {
  constructor(options: {
    login: SqlServerLogin;
    retention?: Temporal.Duration; // 30 days unless set
  });
  readonly retention: Temporal.Duration;
  table(
    name: string, // the reader name: marts.<name> over _warehouse.raw_<name>
    columns?: (c: SqlServerColumns) => SqlServerColumn[],
  ): SqlServerTable;
  location(target: SqlServerTable): string; // 'raw_<name>'
  positions(after?: string): Promise<readonly string[] | { expired: string }>;
  reading(position?: string): Promise<SqlServerReading | { expired: string }>;
}

class SqlServerTable {
  readonly name: string; // the reader name
  readonly raw: string; // raw_<name>
}

class View {
  constructor(options: {
    into: SqlServerDestination;
    name: string;
    description: string;
    columns: Readonly<Record<string, string>>;
    sql: string;
  });
}

class ComputedDataset<Input, Output> {
  constructor(options: {
    into: SqlServerDestination;
    name: string;
    description: string;
    from: readonly (SqlServerTable | View)[];
    compute: Rule<Input, Output>;
    // T-SQL that runs each time the dataset makes its raw table, such as a vector index.
    afterCreate?: (table: string) => readonly string[];
  });
}

class SqlServerCheckpointStore {
  constructor(options: { login: SqlServerLogin });
}

class SqlServerSyncHistory {
  constructor(options: { login: SqlServerLogin; readers?: readonly string[] });
}

type SqlServerReading = AsyncDisposable & {
  readonly sql: mssql.Transaction; // SNAPSHOT, read-only, its own connection
  readonly position: string;
  readonly at: Date;
};

function readPassStatus(login: SqlServerLogin): Promise<PassStatus>;
```

## What each call does underneath

| Call                                      | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new SqlServerDestination(…)`             | Checks the retention. No I/O                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pipeline.run()` → `load()`               | Opens one connection. Checks the engine and the row versioning of the database. Opens a load in `_warehouse._elt_loads`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `prepare(…)`                              | Checks `_elt_writers` and the stored table. Makes a `#stage` table on the connection of the load. Publishes nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| each operation                            | Goes to the stage in batches of at most 1,000 rows or 16 MiB, as one `NVARCHAR(MAX)` JSON parameter that `OPENJSON … WITH (…)` reads and casts for each column ([ADR 0011](./docs/adr/0011-a-batch-travels-as-one-json-parameter-that-openjson-reads.md))                                                                                                                                                                                                                                                                                                                                                                              |
| each commit                               | One transaction: inserts its commit row, takes `CAST(inserted.number AS bigint)` as its number ([ADR 0002](./docs/adr/0002-a-commit-number-is-the-rowversion-of-its-commit-row.md)), then one `INSERT` from the stage into the table for `append`, or one `MERGE` for `append_dedup`, whose `OUTPUT` puts each replaced or removed row into the history. The commit of an `overwrite` or `overwrite_dedup` run replaces the rows by difference instead: one `DELETE … OUTPUT deleted.*` into the history, then one `INSERT` ([ADR 0005](./docs/adr/0005-a-commit-is-one-merge-whose-output-keeps-the-replaced-rows-in-the-history.md)) |
| the first commit of a stream              | Also makes the table, its clustered `_elt_row` key ([ADR 0003](./docs/adr/0003-a-raw-table-numbers-its-rows-with-an-identity-column.md)), the unique index on `_elt_key_hash` ([ADR 0004](./docs/adr/0004-a-key-is-indexed-by-its-hash.md)), the extended properties, the reader view and the writer                                                                                                                                                                                                                                                                                                                                   |
| a change of shape or the swap of a reload | `SET LOCK_TIMEOUT 3000`, `ALTER TABLE` or two `sp_rename` calls, then `sp_refreshview` for each view over the table ([ADR 0006](./docs/adr/0006-a-change-of-a-table-refreshes-the-views-over-it.md))                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `positions(after)`                        | Reads `MIN_ACTIVE_ROWVERSION()`, then `_elt_commits` and `_elt_loads` in one `SNAPSHOT` transaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `reading(position)`                       | Opens a connection, reads the high-water mark, begins a `SNAPSHOT` transaction, and sets `elt.position` with `sp_set_session_context … @read_only = 1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| a refresh of a `ComputedDataset`          | Compares the inputs with the output rows, calls the rule, and commits each settled call. A `vector(n)` value goes as the JSON text of `@zukhruf/vectors/sqlserver` and lands through `CAST(… AS VECTOR(n))`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SqlServerCheckpointStore` acquire        | One session lock of `sp_getapplock` for each copy `id`, through `SqlServerStore` of `@zukhruf/mutex/sqlserver` ([ADR 0009](./docs/adr/0009-each-lock-is-an-application-lock-of-sql-server.md))                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Columns

Inferred columns follow the stream schema, as in Postgres, with the types of SQL Server:

| JSON Schema                                     | SQL Server                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `string`                                        | `NVARCHAR(MAX)`                                                               |
| `string` + `format: 'date'`                     | `DATE`                                                                        |
| `string` + `format: 'date-time'`, precision ≤ 7 | `DATETIMEOFFSET(p)`                                                           |
| `string` + `format: 'date-time-local'`, ≤ 7     | `DATETIME2(p)`                                                                |
| `string` + `format: 'time-local'`, ≤ 7          | `TIME(p)`                                                                     |
| any of those three at precision 8–9             | `NVARCHAR(MAX)`, compared with a binary collation                             |
| `string` + `format: 'int64'`                    | `BIGINT`                                                                      |
| `string` + `format: 'decimal'`, precision ≤ 38  | `DECIMAL(precision, scale)`, or `NVARCHAR(MAX)` when not declared or above 38 |
| `string` + `contentEncoding: 'base64'`          | `VARBINARY(MAX)`                                                              |
| `integer`                                       | `BIGINT`                                                                      |
| `number`                                        | `FLOAT` (53 bits)                                                             |
| `boolean`                                       | `BIT`                                                                         |
| `array`                                         | `JSON`, with `CHECK (ISJSON(column, ARRAY) = 1)`                              |
| a `vector(n)` column of a rule                  | `VECTOR(n)`, float32, n at most 1,998                                         |

- SQL Server keeps time to 100 nanoseconds. Thus the `datetime2(7)` of a SQL Server source loads as `DATETIME2(7)` with no loss. Postgres keeps it as text.
- A `DATETIMEOFFSET` keeps the offset that the value had. A Postgres `TIMESTAMPTZ` does not. Readers compare two values by their instant in both.
- `DATE` starts at the year 0001. A value of the year 0000 fails its commit, and the error names the column and the key.
- Text is `NVARCHAR` (UTF-16), as in the SQL Server destination of Fivetran. A cursor of text compares with the binary order of its UTF-8 bytes, as `COLLATE "C"` does in Postgres: the comparison casts to `VARCHAR(MAX) COLLATE Latin1_General_100_BIN2_UTF8`. The collation of the database applies to the reader's own `WHERE`.
- `VECTOR` has no comparison operators and cannot be a key column. The row hash counts it, so no SQL compares it ([ADR 0004](./docs/adr/0004-a-key-is-indexed-by-its-hash.md)).
- Explicit columns are `columns.text`, `integer`, `int64`, `real`, `boolean`, `date`, `timestamp`, `localTimestamp(field, precision)` and `blob(field)`, with `.notNull()` and `.primaryKey()`, as in Postgres.
- Table, view and column names follow the [naming rule](../../elt/README.md#names). SQL Server keeps 128 characters of a name. A longer name keeps its first 119 characters, then `_` and the first 8 hex digits of the SHA-256 of the field or the requested name. The destination compares names without case, as SQLite does, because the default collation of a database does so. It reserves `loaded_at`, `committed_in`, `replaced_in`, `_elt_row`, `_elt_row_hash` and `_elt_key_hash`.

## Store vectors

The computed dataset of an [`Embedding`](../../embedding/README.md) rule keeps its vectors in a `VECTOR(n)` column. The rule says how many dimensions its model gives, as a pgai vectorizer does ([ADR 0007](./docs/adr/0007-a-rule-column-can-be-a-vector-with-a-fixed-number-of-dimensions.md)):

```ts
import { openai } from '@ai-sdk/openai';

import { ComputedDataset } from '@eltjs/elt-sqlserver';
import { Embedding } from '@eltjs/embedding';

new ComputedDataset({
  into: marts,
  name: 'staff_passage_vectors',
  description: 'The vector of each staff passage.',
  from: [passages],
  compute: new Embedding({
    model: openai.embedding('text-embedding-3-small'),
    dimensions: 1536,
    clock: globalThis,
    key: 'id',
    fields: ['text'],
  }),
  afterCreate: (table) => [
    `CREATE VECTOR INDEX ix_staff_passage_vectors ON ${table} (vector) WITH (METRIC = 'cosine', TYPE = 'DiskANN')`,
  ],
});
```

- The raw table `_warehouse.raw_staff_passage_vectors` has the column `vector VECTOR(1536)`. A value is the JSON text of `toSql` of `@zukhruf/vectors/sqlserver`, with 9 significant digits, which keeps each float32 value; the commit casts it with `CAST(… AS VECTOR(1536))`.
- A rule column of more than 1,998 dimensions fails the constructor of `ComputedDataset` with a `TypeError` that names the column and the limit of a float32 `VECTOR`.
- `afterCreate` gives T-SQL that runs in the transaction that makes the raw table, each time the dataset makes it ([ADR 0008](./docs/adr/0008-a-computed-dataset-runs-the-sql-of-the-host-each-time-it-makes-its-raw-table.md)). Thus a vector index stays when a changed declaration makes the table again. An index made on an empty table starts as an exact index, and Azure SQL builds its graph after the rows come (`@zukhruf/vectors`, "SQL Server: what the probes found").
- The search is the host's own SQL, with every feature of Azure SQL:

```sql
DECLARE @qv VECTOR(1536) = CAST(@q AS VECTOR(1536));
SELECT TOP (10) WITH APPROXIMATE v.id, r.distance
FROM VECTOR_SEARCH(TABLE = marts.staff_passage_vectors AS v, COLUMN = vector, SIMILAR_TO = @qv, METRIC = 'cosine') AS r
WHERE v.status = 'computed'
ORDER BY r.distance;
```

## File bytes in the database

As in Postgres: parsed content is `NVARCHAR(MAX)`. The column of an original file holds a `UNIQUEIDENTIFIER`. Its bytes are in a table `_warehouse._elt_files_<hash>` for each column, which readers read through the view `marts._elt_files_<hash>`, as `(file UNIQUEIDENTIFIER, n BIGINT, bytes VARBINARY(MAX))` chunks of up to 4 MiB. The chunks of a load wait in a `#` table of the connection until the commit of their rows moves them. The rules of removal, history and clear are those of [elt-postgresql](../postgresql/README.md#file-bytes-in-the-database).

## Descriptions

The descriptions of the source become `MS_Description` extended properties of each table, view and column (`sp_addextendedproperty`, `sp_updateextendedproperty`), the property that SQL Server Management Studio and the SQL Server source of elt read. The rules are those of [elt-postgresql](../postgresql/README.md#descriptions). An extended property holds at most 7,500 bytes; a longer description fails the declaration of the copy before a connection reads.

## Locks and commits

- As in Postgres, a load takes no schema lock, and no transaction stays open between commits. Each commit is one short transaction.
- Readers never wait for a load: with `READ_COMMITTED_SNAPSHOT` on, a reader reads the last committed version of each row. A `DELETE` or a `MERGE` that escalates to a table lock does not block them.
- Before the commits of a load, the writer makes the tables that the targets of one database share in `_warehouse`, when they are not there, in a transaction of its own that holds a transaction lock of `sp_getapplock` on `_warehouse`, as in Postgres. No commit holds that lock. The publication and the withdrawal of a view take the lock of `marts` ([ADR 0009](./docs/adr/0009-each-lock-is-an-application-lock-of-sql-server.md)).
- A deduplicating commit merges the stage of one stream into its table with one `MERGE` on `_elt_key_hash`. The result is the same as when the operations apply one at a time, as in Postgres. The `OUTPUT` of the `MERGE` gives each row that it updated or deleted, and the same statement inserts them into the history ([ADR 0005](./docs/adr/0005-a-commit-is-one-merge-whose-output-keeps-the-replaced-rows-in-the-history.md)). See "Deduplication" below.
- An overwrite replaces the rows by difference with `DELETE`, not `TRUNCATE`: `TRUNCATE` takes a schema modification lock, and readers wait for it. The rows of the table and the records of the commit match as multisets of row hashes: the k-th row with a hash matches the k-th record with that hash, by the order of `_elt_row` and of the stage. A row with no match goes, and the same statement keeps it in the history (`INSERT INTO <history> SELECT … FROM (DELETE … OUTPUT deleted.*)`). A row with a match stays with its `committed_in` and its `loaded_at`. A record with no match enters. An `overwrite_dedup` matches only the record of each key that its reduced stage keeps. A reset deletes its scope in the same way.
- A row is told apart by `_elt_row`, its identity number, where Postgres uses `ctid` and SQLite uses `_rowid_` ([ADR 0003](./docs/adr/0003-a-raw-table-numbers-its-rows-with-an-identity-column.md)).
- The writer of each table is in `_warehouse._elt_writers`, by the [target ownership](../../elt/README.md#target-ownership) rule.

Shape changes:

- When the columns, types or `NOT NULL`s of a stored table do not fit the stream, the load evolves it in place before it reads. `ALTER TABLE … ADD` a nullable column, `DROP COLUMN`, and `ALTER COLUMN … type`. Before a conversion, each stored value that is not null must convert back to itself (`TRY_CAST(TRY_CAST(column AS new) AS old) = column` for each row), so `1.5` in `FLOAT` fails the load to `BIGINT` and names the column. `VECTOR` converts only to and from text, so a change of the dimensions of a rule column makes the raw table again.
- A change waits at most 3 seconds for readers (`SET LOCK_TIMEOUT 3000`), because `ALTER COLUMN` takes a schema modification lock, which also blocks readers that use row versions. Then it fails the copy until the next run.
- A reload goes into a hidden table `_elt_next_<hash>`. The end of the reload gives its rows to the table by difference when the shapes agree, and swaps it in with `sp_rename` when they do not. The swapped-in table takes the grants of the old one, as Snowflake's `COPY GRANTS` does.
- The views over the table read the new table after the change: SQL Server finds the tables of a view by name, so the destination only runs `sp_refreshview` for each of them. A change that a view `WITH SCHEMABINDING` stops, such as a swap, fails, and the destination names the schema-bound views in its error; an added column goes through ([ADR 0006](./docs/adr/0006-a-change-of-a-table-refreshes-the-views-over-it.md)).

## Deduplication

An `append_dedup` copy keeps one row for each key, as in [elt-postgresql](../postgresql/README.md#locks-and-commits). The key is the key of the stream, or the `primaryKey` of the copy.

- The stage keeps each operation in the order of the source: a record, or a deletion of its key (`_elt_op`). A deletion carries the key values and its key hash, and no row hash.
- The rows match by `_elt_key_hash`, the SHA-256 of the JSON array of the key values, with a unique index on it. Thus two keys that differ only in case, such as `A` and `a`, stay two rows ([ADR 0004](./docs/adr/0004-a-key-is-indexed-by-its-hash.md)).
- A commit first reduces its stage to one operation for each key hash, as if the operations applied one at a time: only the operations after the last deletion of a key count, and a deletion with no record after it removes the key. `replace` keeps the last record. `cursor_newer` keeps the first record with the greatest cursor.
- Then one statement changes the table and keeps the history: `INSERT INTO <history> SELECT … FROM (MERGE <table> USING <reduced stage> … OUTPUT deleted.*) WHERE committed_in IS NOT NULL` ([ADR 0005](./docs/adr/0005-a-commit-is-one-merge-whose-output-keeps-the-replaced-rows-in-the-history.md)). A deletion deletes its row. A record after a deletion of its key replaces the row. Another record replaces the row when its row hash differs and, for `cursor_newer`, when its cursor is greater than the cursor of the row. A record of a new key is inserted. An inserted row outputs a `deleted` row of nulls, which the history does not keep.
- A record with the row hash of the stored row leaves the row, its `loaded_at` and its `committed_in` as they are, and the history keeps nothing. A commit that changes no row takes back its commit row, so it gives no position.
- A text cursor compares by its UTF-8 bytes: `CONVERT(varchar(max), cursor COLLATE Latin1_General_100_BIN2_UTF8)`, as `COLLATE "C"` does in Postgres. Thus `B` comes before `a`, and `Ａ` (U+FF21) comes before an emoji.
- The index of the key hash is named after the table and its key (`_elt_key_<hash>`). After a checkpoint reset that gives the copy another key, the stored hashes are of the old key, so the table no longer fits, and the copy fails with no change to the table; clear the copy to load it again.
- A stored row with a null key or cursor fails the load with `Existing deduplication keys and cursors must be non-null`, as in Postgres.

## Commit numbers and positions

One numbering orders the commits of the whole database, in the schema `_warehouse`, as in Postgres. The tables and the rules are those of [elt-postgresql](../postgresql/README.md#commit-numbers-and-positions): `_elt_commits`, `_elt_loads`, `_elt_epoch` with `min_valid` and `expired_by`, positions `<epoch>:<number>`, the history of each table, the widening rule, retention, and the clear that forgets.

How SQL Server is different:

- A commit number is the `rowversion` of the commit's row in `_elt_commits`, which the commit inserts before it changes a row. `MIN_ACTIVE_ROWVERSION()` gives the lowest number that a transaction still holds, so each number below it is settled: the high-water mark is `MIN_ACTIVE_ROWVERSION() - 1`. No lock and no sequence is necessary ([ADR 0002](./docs/adr/0002-a-commit-number-is-the-rowversion-of-its-commit-row.md)).
- Numbers are not dense. Writes of other `rowversion` columns of the database and commits that rolled back are gaps, which a reader skips, as in Postgres.
- A transaction that changes no row deletes its commit row before it commits, so it takes no number that a reader sees.
- The widenings of SQL Server: any type to `NVARCHAR(MAX)`, `BIGINT` to `DECIMAL(38, 0)`, `DATE` to `DATETIME2`, `DATETIME2(p)` to `DATETIME2(q)` with q > p, `DECIMAL(p, s)` to a precision and scale that hold it. Any other change of type sets `min_valid`, as in Postgres.

A reading as of a position:

- Each reader view reads its table as of the position in `SESSION_CONTEXT(N'elt.position')`: the rows of the table with `committed_in <= P`, and the rows of the history with `committed_in <= P < replaced_in`. A session that sets nothing reads the table as it is now. A view built on a reader view reads as of the same position ([ADR 0010](./docs/adr/0010-a-reading-sets-its-position-in-the-session-context-and-reads-row-versions.md)).
- `await destination.reading(position?)` gives `{ sql, position, at }` or `{ expired }`, as in Postgres. `sql` is a `SNAPSHOT` transaction of its own connection, and the position is a read-only key of its session context, so the reader cannot change it.

## Checkpoints

`SqlServerCheckpointStore({ login })` keeps the checkpoints of every connection in `_warehouse._elt_checkpoints`, beside the data, as in Postgres. The key is the id of the copy, so the copy ids of every connection of the database must be different. `binding` and `state` are `NVARCHAR(MAX)`, which keeps each UTF-16 code unit, also `\u0000` and lone surrogates; the `JSON` type would refuse such text. The store holds one session lock for each copy `id` through `SqlServerStore` of `@zukhruf/mutex/sqlserver`, as `SQLiteCheckpointStore` holds one through `SqliteStore` of `@zukhruf/mutex/sqlite`. A run that finds one ID in use fails with `Checkpoint <id> is in use by another run`. The server releases a session lock when the session ends.

## Reader views

As in [elt-postgresql](../postgresql/README.md#reader-views): `table(name)` names the view `marts.<name>` over `_warehouse.raw_<name>`. `committed_in`, `_elt_row`, `_elt_row_hash`, `_elt_key_hash` and `replaced_in` are internal, and the reader view does not show them.

## Declare a view

As in [elt-postgresql](../postgresql/README.md#declare-a-view). The view lives in `marts`, and the bare names of its SQL are found in `marts`, as in Postgres. Thus the SQL reads the reader views. SQL Server resolves a bare name inside a view through the schema of the view and then `dbo`, for each user; the default schema of the user takes no part ([probe of 2026-11-20](./docs/adr/0006-a-change-of-a-table-refreshes-the-views-over-it.md#probe-2026-11-20-a-bare-table-name-inside-a-view)). Name a relation of another schema with its schema, such as `_warehouse.raw_drive_items`. A missing relation is error 208 (`Invalid object name`), and the view waits only when the pipeline makes that relation. A refresh that changes nothing compares the stored definition (`OBJECT_DEFINITION`) with the new text, and leaves the view as it was.

## Declare a computed dataset

As in [elt-postgresql](../postgresql/README.md#declare-a-computed-dataset). A computed dataset keeps one output row for each key, in the table `_warehouse.raw_<name>`, beside its history. Readers query the view `marts.<name>`. The columns are the key, `input_hash`, `rule`, `status`, `error`, and the columns of the rule. A `text` column of a rule is `NVARCHAR(MAX)`, an `integer` column is `BIGINT`, a `blob` column is `VARBINARY(MAX)`, and a `vector(n)` column is `VECTOR(n)`. The key is `NVARCHAR(MAX)`, and the table is unique on the hash of the key ([ADR 0004](./docs/adr/0004-a-key-is-indexed-by-its-hash.md)). The refresh, its commits, its positions and its status follow elt-postgresql.

## When something fails

As in [elt-postgresql](../postgresql/README.md#when-something-fails). Also:

- A database with no row versioning for readers fails the first load with the failure type `config`.
- An engine older than SQL Server 2025 fails the first load with the failure type `config`.
- A value that a column refuses, such as a vector of other dimensions than its column, fails its commit. The error names the column and the key.

## Sync history

`SqlServerSyncHistory({ login, readers })` is the sync history of a pipeline that loads into SQL Server, with the tables, views and rules of [elt-postgresql](../postgresql/README.md#sync-history): `_warehouse.sync_attempts`, `extraction_coverage`, `stream_checks` and `derived_status`, and the views `sync_attempts`, `extraction_coverage`, `sync_status`, `stream_status`, `derived_status` and `catalog` in `marts`. `install()` makes them in one transaction. `readers` are database users or roles; each install grants them `SELECT` on the numbering and nothing else of `_warehouse`. Each attempt has a session of its own that holds a session lock of `sp_getapplock` on the attempt, so the next attempt of its connection finds a pass whose process stopped and records it as `failed` (elt-postgresql ADR 0009). The `catalog` reads the `MS_Description` extended properties. `readPassStatus(login)` gives the latest pass of the database, as it does for Postgres.

## Derived status

As in [elt-postgresql](../postgresql/README.md#derived-status), from elt ADR 0025: one row of `_warehouse.derived_status` for each view and computed dataset, named with its schema, which readers see as `marts.derived_status`.

## Errors

| Error                                                                             | When                                                                                                                                                        | The caller's next step                                          |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `TypeError`                                                                       | A declaration that the destination cannot hold, such as a reader name of a relation that the sync history publishes, or a `vector(n)` column with n > 1,998 | Change the declaration                                          |
| `RangeError`                                                                      | A negative retention                                                                                                                                        | Give a retention of zero or more                                |
| `TargetOwnedError` of elt                                                         | A second writer of a table                                                                                                                                  | Clear the target with the copy that owns it                     |
| `DerivedDatasetError` of elt                                                      | A dataset failure, such as SQL that SQL Server refuses                                                                                                      | Fix the SQL of the view                                         |
| `SqlServerSetupError`, with the failure type `config`                             | No row versioning for readers, an engine older than SQL Server 2025                                                                                         | Run the `ALTER DATABASE` of the message, or use SQL Server 2025 |
| `SqlServerLoginError` of sdk-microsoft-sql-server, with the failure type `config` | A login that the server refuses: wrong credentials, a disabled login, a database that it may not open                                                       | Fix the login                                                   |
| An error 229, 230 or 262 of SQL Server, with the failure type `config`            | A login that may not do what a statement needs, such as `CREATE TABLE` for the checkpoints                                                                  | Grant the login the permission that the message names           |

## The same concepts in other systems

| Here                                 | Airbyte destination-mssql                                     | Fivetran SQL Server | dlt mssql                             | Debezium JDBC sink (SQL Server) | Meltano target-mssql (storebrand) |
| ------------------------------------ | ------------------------------------------------------------- | ------------------- | ------------------------------------- | ------------------------------- | --------------------------------- |
| one JSON batch through `OPENJSON`    | `INSERT` statements, or `BULK INSERT` from Azure Blob Storage | not documented      | `INSERT` of at most 1,000 rows        | prepared statements             | a bulk insert into a `#` table    |
| `MERGE` on `_elt_key_hash`           | deduped sync modes; the mechanism is not documented           | not documented      | `delete-insert` (default) or `upsert` | `MERGE` on the primary key      | `MERGE` from the `#` table        |
| text as `NVARCHAR(MAX)`              | `VARCHAR(MAX)` for its own columns                            | `NVARCHAR`          | JSON as `nvarchar`                    | `NVARCHAR`                      | not documented                    |
| `DATETIMEOFFSET` for an instant      | `DATETIMEOFFSET`                                              | `DATETIMEOFFSET`    | not documented                        | `TIMESTAMP`                     | not documented                    |
| evolve: add, drop, cast with a check | not documented                                                | not documented      | adds columns                          | adds columns only               | not documented                    |
| `VECTOR(n)` rule column              | none                                                          | none                | none                                  | "Vector types are unsupported"  | none                              |

Sources: [Airbyte](https://docs.airbyte.com/integrations/destinations/mssql), [Fivetran](https://fivetran.com/docs/destinations/sql-server), [dlt mssql](https://dlthub.com/docs/dlt-ecosystem/destinations/mssql) and [merge loading](https://dlthub.com/docs/general-usage/merge-loading), [Debezium JDBC sink](https://debezium.io/documentation/reference/stable/connectors/jdbc.html), [storebrand/target-mssql `sinks.py`](https://github.com/storebrand/target-mssql/blob/main/target_mssql/sinks.py), [pgai vectorizer](https://github.com/timescale/pgai/blob/main/docs/vectorizer/api-reference.md).

## Why no package does the job

Checked on 2026-11-19 (Node.js 26.13.0; npm search for `sql server destination`, `mssql elt`, `mssql etl loader`, `singer target mssql`, `airbyte mssql`, `mssql vector`, `mssql bulk upsert`, `dlt mssql`, and the `@stdlib` scope for `sqlserver`):

| Candidate                                    | Downloads a week | Why it does not do the job                                                                   |
| -------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------- |
| Node.js built-ins                            | n/a              | No SQL Server client, no TDS. A search of the exports of every built-in module found nothing |
| `mssql` 12.7.15 (on tedious 20.3.9)          | 4,980,600        | The driver, not a destination. The destination uses it, as the SQL Server SDK of elt does    |
| `faros-airbyte-cdk` 0.23.67                  | 3,301            | A connector kit of Airbyte for JavaScript; it gives no SQL Server destination                |
| `airbyte-faros-destination` 0.23.67          | 1,748            | It writes to the Faros API, not to SQL Server                                                |
| `@prisma/adapter-mssql` 7.10.1               | 127,540          | A driver adapter of an ORM                                                                   |
| Airbyte, dlt, Meltano, Debezium destinations | n/a              | Java, Kotlin and Python programs; none keeps elt's positions, history or derived datasets    |

`@zukhruf/vectors/sqlserver` is adopted for the vector form (its ADR 0007, "SQL Server gets JSON text with the digits that keep each value"), and `@zukhruf/mutex/sqlserver` for the checkpoint locks.

## Who uses what

| Package or host                    | What it takes                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| datahub, `apps/semantic-layer/elt` | `SqlServerDestination`, `View`, `ComputedDataset` with `Embedding` (backlog #4738), the history                                                                                                                                                                                                                               |
| `@eltjs/elt`                       | gives the `Destination` port, `Rule` with the `vector` column ([ADR 0007](./docs/adr/0007-a-rule-column-can-be-a-vector-with-a-fixed-number-of-dimensions.md)), and the rules that three destinations share ([ADR 0012](./docs/adr/0012-the-rules-that-the-destinations-share-move-into-elt-before-the-third-destination.md)) |
| `@eltjs/embedding`                 | gives `Vector` values of its `dimensions`                                                                                                                                                                                                                                                                                     |
| `@zukhruf/vectors`                 | `toSql` and the `VECTOR(n)` type of a column                                                                                                                                                                                                                                                                                  |
| `@zukhruf/mutex`                   | `SqlServerStore` for the checkpoint locks                                                                                                                                                                                                                                                                                     |
| `@zukhruf/testing`                 | `SqlServer`, the database of the tests (SQL Server 2025 in Docker; it has no DiskANN, so the tests run the exact search only)                                                                                                                                                                                                 |

## Ezz's rulings (2026-11-19)

1. **The order.** The SQL Server destination is built last. First the rules that the destinations share move into elt, from the two copies and checked against this paper; then the open defects and the gaps ([ADR 0012](./docs/adr/0012-the-rules-that-the-destinations-share-move-into-elt-before-the-third-destination.md)).
2. **The value of a vector column** is a `Vector` of `@zukhruf/vectors`, and `@eltjs/elt` takes that package ([ADR 0007](./docs/adr/0007-a-rule-column-can-be-a-vector-with-a-fixed-number-of-dimensions.md)).
3. **The login.** The destination takes the `SqlServerDatabase` of `@eltjs/sdk-microsoft-sql-server`, and the SDK gets write sessions.
4. **The type of a vector column.** `@zukhruf/vectors` gives the type for a kind of vector and a count of dimensions, such as `sqlType(Vector, 1536)`.
5. **`afterCreate`.** The name and the shape are accepted, and `View` does not take it ([ADR 0008](./docs/adr/0008-a-computed-dataset-runs-the-sql-of-the-host-each-time-it-makes-its-raw-table.md)).
6. **Keys.** A unique index on `_elt_key_hash` ([ADR 0004](./docs/adr/0004-a-key-is-indexed-by-its-hash.md)).

## Probes to run before code

Each decision above that depends on the behavior of the server has a probe. Run each one on the Azure SQL database of datahub and on SQL Server 2025 in Docker, and paste the output into the ADR.

All seven ran on 2026-11-20, on Azure SQL Database (datahub BILLING) and on SQL Server 2025 (RTM-CU11) in Docker, except where a line says otherwise. Two results corrected a decision: ADR 0006 (a schema-bound view) and ADR 0002 (the mark of a database copy on Azure SQL Database).

- Done: `MIN_ACTIVE_ROWVERSION()` read before a `SNAPSHOT` transaction: a commit at or below the mark is always visible to the snapshot. Holds ([ADR 0002, probe](./docs/adr/0002-a-commit-number-is-the-rowversion-of-its-commit-row.md#probe-2026-11-20-the-high-water-mark-and-a-snapshot-transaction)).
- Done: `MERGE` with `OUTPUT` into the history, through composable DML, on a table with a `VECTOR` column and a DiskANN index. Holds; the index was on Azure SQL only, because SQL Server 2025 in Docker has none ([ADR 0005, probe](./docs/adr/0005-a-commit-is-one-merge-whose-output-keeps-the-replaced-rows-in-the-history.md#probe-2026-11-20)).
- Done: `OPENJSON … WITH (v NVARCHAR(MAX) '$.v')` with `CAST(v AS VECTOR(1536))` for a batch of 64 vectors. Holds; a base64 column must be `varchar(max)` for `BASE64_DECODE` ([ADR 0011, probe](./docs/adr/0011-a-batch-travels-as-one-json-parameter-that-openjson-reads.md#probe-2026-11-20)).
- Done: `sp_rename` of a table while a view reads it, then `sp_refreshview`; and the error of a `SCHEMABINDING` view. The refresh holds; a `SCHEMABINDING` view stops a swap, a drop and a change of a column that it reads, but not an `ADD` or a change of a column that it does not read, so ADR 0006 now says the destination names those views in its own error ([ADR 0006, probe](./docs/adr/0006-a-change-of-a-table-refreshes-the-views-over-it.md#probe-2026-11-20-sp_rename-sp_refreshview-and-schemabinding)).
- Done: `is_read_committed_snapshot_on` and `snapshot_isolation_state` of the datahub database. Both on ([ADR 0010, probe](./docs/adr/0010-a-reading-sets-its-position-in-the-session-context-and-reads-row-versions.md#probe-2026-11-20)).
- Done: How SQL Server resolves a bare table name inside a view in the schema `marts`, when the user that runs the query has another default schema. The schema of the view, then `dbo`, never the default schema of the user; the user with another default schema ran in Docker only ([ADR 0006, probe](./docs/adr/0006-a-change-of-a-table-refreshes-the-views-over-it.md#probe-2026-11-20-a-bare-table-name-inside-a-view)).
- Done: Whether a point-in-time restore of Azure SQL changes `recovery_fork_guid` in `sys.database_recovery_status`, so a restored database can start a new epoch. First in Docker (Ezz, 2026-11-19): on SQL Server 2025 each restore changes it and the numbers repeat after the restore point; Azure SQL Database has no `sys.database_recovery_status` ([ADR 0002, probe](./docs/adr/0002-a-commit-number-is-the-rowversion-of-its-commit-row.md#probe-2026-11-20-recovery_fork_guid-after-a-restore)). A point-in-time restore on Azure SQL Database (a scratch server in Ezz's own subscription, Ezz, 2026-11-20) changes `database_id`, `create_date` and `physical_database_name` of `sys.databases`, which a plain database user can read, and the numbers repeat; the rename to the original name keeps `database_id` and `physical_database_name`, and a change of service objective also changes `physical_database_name`. On Azure SQL Database the epoch keeps all three and starts a new epoch when any one changes, because a missed restore gives wrong rows and a needless new epoch only a full read ([ADR 0002, probe](./docs/adr/0002-a-commit-number-is-the-rowversion-of-its-commit-row.md#probe-2026-11-20-an-azure-sql-database-point-in-time-restore)).

## Decisions

- [ADR 0001](./docs/adr/0001-the-sql-server-destination-takes-the-declarations-of-elt-postgresql.md): the SQL Server destination takes the declarations of elt-postgresql.
- [ADR 0002](./docs/adr/0002-a-commit-number-is-the-rowversion-of-its-commit-row.md): a commit number is the rowversion of its commit row.
- [ADR 0003](./docs/adr/0003-a-raw-table-numbers-its-rows-with-an-identity-column.md): a raw table numbers its rows with an identity column.
- [ADR 0004](./docs/adr/0004-a-key-is-indexed-by-its-hash.md): a key is indexed by its hash.
- [ADR 0005](./docs/adr/0005-a-commit-is-one-merge-whose-output-keeps-the-replaced-rows-in-the-history.md): a commit is one `MERGE` whose output keeps the replaced rows in the history.
- [ADR 0006](./docs/adr/0006-a-change-of-a-table-refreshes-the-views-over-it.md): a change of a table refreshes the views over it.
- [ADR 0007](./docs/adr/0007-a-rule-column-can-be-a-vector-with-a-fixed-number-of-dimensions.md): a rule column can be a vector with a fixed number of dimensions.
- [ADR 0008](./docs/adr/0008-a-computed-dataset-runs-the-sql-of-the-host-each-time-it-makes-its-raw-table.md): a computed dataset runs the SQL of the host each time it makes its raw table.
- [ADR 0009](./docs/adr/0009-each-lock-is-an-application-lock-of-sql-server.md): each lock is an application lock of SQL Server.
- [ADR 0010](./docs/adr/0010-a-reading-sets-its-position-in-the-session-context-and-reads-row-versions.md): a reading sets its position in the session context and reads row versions.
- [ADR 0011](./docs/adr/0011-a-batch-travels-as-one-json-parameter-that-openjson-reads.md): a batch travels as one JSON parameter that `OPENJSON` reads.
- [ADR 0012](./docs/adr/0012-the-rules-that-the-destinations-share-move-into-elt-before-the-third-destination.md): the rules that the destinations share move into elt before the third destination.
