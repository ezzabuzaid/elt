# @eltjs/elt-sqlserver

The SQL Server destination of elt. It loads each stream of a connection into a SQL Server or Azure SQL database, with typed columns, and it does not block readers while it loads. Each target is a reader view in `marts`, which the host names, over a raw table in `_warehouse`. It also keeps the views and computed datasets that the pipeline derives. A computed dataset can keep a vector column as a native `VECTOR(n)`, so Azure SQL searches it with `VECTOR_DISTANCE` or a DiskANN index. The checkpoint store and the sync history keep their data in the same database.

The destination gives the contract of [elt-postgresql](../postgresql/README.md): the same declarations, the same columns for readers, the same positions, history, retention and sync history. A host changes its destination and nothing else. Where SQL Server is different, this README says how and why ([ADR 0001](./docs/adr/0001-the-sql-server-destination-takes-the-declarations-of-elt-postgresql.md)).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md), and the glossary of [elt](../../elt/CONTEXT.md) for the words of all of elt.

## The map

| Now (first release)                                                                                                                                                                                                                                                              | Later                                                                                                                               | Never                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SqlServerDestination`: the four destination sync modes, evolve, reload, reader views, extended properties                                                                                                                                                                       | Native `VECTOR` over TDS, when tedious has it ([tedious #1841](https://github.com/tediousjs/tedious/pull/1841))                     | A search API beyond the `_nearest` function of a vector index: any other search is the host's SQL (`@zukhruf/vectors/sqlserver`)                     |
| Numbered commits, positions, history, readings, retention, a clear that forgets                                                                                                                                                                                                  | `float16` vector columns (`HalfVector`), for a model of more than 1,998 dimensions, such as `text-embedding-3-large` (3,072)        | System-versioned temporal tables as the history ([ADR 0001](./docs/adr/0001-the-sql-server-destination-takes-the-declarations-of-elt-postgresql.md)) |
| `View` and `ComputedDataset`, with `vector(n)` rule columns as `VECTOR(n)` and declared indexes: nonclustered, and DiskANN with its search `marts.<name>_nearest`                                                                                                                | A bulk load through Azure Blob Storage and `BULK INSERT`, as the bulk mode of Airbyte, when a load is too slow through JSON batches | An ORM, or a query builder over the reader's SQL                                                                                                     |
| `SqlServerCheckpointStore`, `SqlServerSyncHistory` (with `derived_status`, `catalog` and named readers), `readPassStatus`                                                                                                                                                        | Microsoft Entra ID logins (managed identity), which `mssql` supports through `authentication`                                       | An `mssql://` URL                                                                                                                                    |
| The prerequisites in other packages: the `vector` rule column of elt, `dimensions` on `Embedding`, and the extraction of the rules that the destinations share ([ADR 0012](./docs/adr/0012-the-rules-that-the-destinations-share-move-into-elt-before-the-third-destination.md)) | SQL Server 2022 and older, which have no `VECTOR` and no `JSON` type                                                                | A migration of stored data between versions (elt AGENTS.md: stored data is disposable)                                                               |

### What the first release does

- `SqlServerDestination` with the four destination sync modes: the raw table with its `_elt_row` identity key (ADR 0003), the unique index on `_elt_key_hash` when the copy deduplicates or the columns declare a key (ADR 0004), the `MERGE` of a deduplicating commit (ADR 0005, see "Deduplication" below), the replacement by difference of an overwrite (see "Locks and commits" below), the history table, the `MS_Description` extended properties, the reader view, and `positions()`.
- The JSON batches through `OPENJSON` (ADR 0011), the check of the engine and the row versioning at each load (ADR 0010), the numbering with the rowversion of the commit row and the mark of the database copy (ADR 0002), and the clear that forgets.
- The reset and the reload: a `RESET` of the stream or of a partition, and an overwrite whose stored table no longer has the shape of its stream, load into a hidden table, which the end of the stream gives to the table by difference or swaps in (see "Shape changes" below).
- `SqlServerCheckpointStore` and `SqlServerSyncHistory`, with the application locks of ADR 0009.
- The evolve: a load that is not an overwrite, whose stored table no longer has the shape of its stream, changes the table in place with `ALTER TABLE`, in one commit of its own, and the history follows each widening (see "Shape changes" below).
- The file columns: parsed text and references to the files of a storage (see "Files" below).
- `reading(position?)`: a session of its own that reads the database as of a position (see "Commit numbers and positions" below), and `readPassStatus(login)`.
- `View`, and its rows of `derived_status` (see "Declare a view" and "Derived status" below).
- `ComputedDataset` of a `Rule` or a `TableRule`, with `text`, `blob`, `integer` and `vector(n)` rule columns, the parts table of a `TableRule`, declared indexes, and its rows of `derived_status` (see "Declare a computed dataset" below).
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

class ComputedDataset<Input> {
  constructor(
    options: {
      into: SqlServerDestination;
      name: string;
      description: string;
      from: readonly (SqlServerTable | View)[];
      indexes?: readonly SqlServerIndex[]; // of _warehouse.raw_<name>
    } & (
      | { compute: Rule<Input, RuleColumns> }
      | {
          compute: TableRule<Input, RuleColumns, RuleColumns>;
          partIndexes?: readonly SqlServerIndex[]; // of _warehouse.raw_<name>_parts
        }
    ),
  );
}

type SqlServerIndex =
  | { type: 'nonclustered'; columns: readonly [string, ...string[]] }
  | { type: 'vector'; column: string; metric: 'cosine' | 'euclidean' | 'dot' }; // DiskANN

class SqlServerCheckpointStore {
  constructor(options: { login: SqlServerLogin });
}

class SqlServerSyncHistory {
  constructor(options: { login: SqlServerLogin; readers?: readonly string[] });
}

type SqlServerReading = AsyncDisposable & {
  readonly sql: SqlServerConnection; // of @eltjs/sdk-microsoft-sql-server: its own session, in a SNAPSHOT transaction
  readonly position: string;
  readonly at: Temporal.Instant; // when the commit of the position was made
};

function readPassStatus(login: SqlServerLogin): Promise<{
  readonly pass: PassStatus | null;
  readonly streams: readonly StreamPassStatus[];
}>;
```

## What each call does underneath

| Call                                      | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new SqlServerDestination(…)`             | Checks the retention. No I/O                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pipeline.run()` → `load()`               | Opens one connection. Checks the engine and the row versioning of the database. Opens a load in `_warehouse._elt_loads`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `prepare(…)`                              | Checks `_elt_writers` and the stored table. Makes a `#stage` table on the connection of the load. Evolves a stored table that no longer has the shape of the stream, in one commit, when the copy does not overwrite. Publishes no row of the stream                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| each operation                            | Goes to the stage in batches of at most 1,000 rows or 16 MiB, as one `NVARCHAR(MAX)` JSON parameter that `OPENJSON … WITH (…)` reads and casts for each column ([ADR 0011](./docs/adr/0011-a-batch-travels-as-one-json-parameter-that-openjson-reads.md))                                                                                                                                                                                                                                                                                                                                                                                                                               |
| each commit                               | One transaction: inserts its commit row, takes `CAST(inserted.number AS bigint)` as its number ([ADR 0002](./docs/adr/0002-a-commit-number-is-the-rowversion-of-its-commit-row.md)), then one `INSERT` from the stage into the table for `append`, or one `MERGE` for `append_dedup`, whose `OUTPUT` puts each replaced or removed row into the history. The commit of an `overwrite` or `overwrite_dedup` run replaces the rows by difference instead: one `DELETE … OUTPUT deleted.*` into the history, then one `INSERT` ([ADR 0005](./docs/adr/0005-a-commit-is-one-merge-whose-output-keeps-the-replaced-rows-in-the-history.md))                                                  |
| the first commit of a stream              | Also makes the table, its clustered `_elt_row` key ([ADR 0003](./docs/adr/0003-a-raw-table-numbers-its-rows-with-an-identity-column.md)), the unique index on `_elt_key_hash` ([ADR 0004](./docs/adr/0004-a-key-is-indexed-by-its-hash.md)), the extended properties, the reader view and the writer                                                                                                                                                                                                                                                                                                                                                                                    |
| a change of shape or the swap of a reload | `SET LOCK_TIMEOUT 3000`, `ALTER TABLE` or two `sp_rename` calls, then `sp_refreshview` for each view over the table ([ADR 0006](./docs/adr/0006-a-change-of-a-table-refreshes-the-views-over-it.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `positions(after)`                        | Reads `MIN_ACTIVE_ROWVERSION()`, then `_elt_commits` and `_elt_loads` in one `SNAPSHOT` transaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `reading(position)`                       | Opens a connection, checks the engine and the row versioning, reads the high-water mark, begins a `SNAPSHOT` transaction, and sets `elt.position` with `sp_set_session_context … @read_only = 1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| a refresh of a `View`                     | Opens one connection. In one transaction under the lock of `marts`, reads `OBJECT_DEFINITION` of the view, and runs `CREATE OR ALTER VIEW` and `sp_refreshview` of each view over it only when the text differs. Writes the row of `derived_status`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| a refresh of a `ComputedDataset`          | Opens a load of the dataset. In one transaction, makes the raw table, its history and its reader view, or makes the table again when its declaration changed, and removes the rows whose input is gone. Then reconciles the declared indexes with `sys.indexes`, one statement at a time outside a transaction. Then calls the rule, and for each settled call runs one transaction: it reads the row hashes of the call's keys, runs one `MERGE` of the changed rows from `OPENJSON`, whose `OUTPUT` the history keeps, and takes the settled inputs off `pending`. A `vector(n)` value goes as the JSON text of `@zukhruf/vectors/sqlserver` and lands through `CAST(… AS VECTOR(n))` |
| `SqlServerCheckpointStore` acquire        | One session lock of `sp_getapplock` for each copy `id`, through `SqlServerStore` of `@zukhruf/mutex/sqlserver` ([ADR 0009](./docs/adr/0009-each-lock-is-an-application-lock-of-sql-server.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

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
  indexes: [{ type: 'vector', column: 'vector', metric: 'cosine' }],
});
```

- The raw table `_warehouse.raw_staff_passage_vectors` has the column `vector VECTOR(1536)`. A value is the JSON text of `toSql` of `@zukhruf/vectors/sqlserver`, with 9 significant digits, which keeps each float32 value; the commit casts it with `CAST(… AS VECTOR(1536))`.
- A rule column of more than 1,998 dimensions fails the constructor of `ComputedDataset` with a `TypeError` that names the column and the limit of a float32 `VECTOR`.
- The vector index is `CREATE VECTOR INDEX … ON [_warehouse].[raw_staff_passage_vectors] ([vector]) WITH (METRIC = 'cosine', TYPE = 'DiskANN')`, which each refresh makes when the table does not have it, also after a changed declaration makes the table again (see "Declare a computed dataset" below). An index made on an empty table starts as an exact index, and Azure SQL builds its graph after the rows come (`@zukhruf/vectors`, "SQL Server: what the probes found").
- SQL Server 2025 in Docker makes a vector index only with `PREVIEW_FEATURES` on and only on an `int` clustered key, so it refuses the index of a computed dataset (error 42217); the tests check the statement there and nothing more ([ADR 0013, probe](./docs/adr/0013-a-computed-dataset-declares-its-indexes-and-the-destination-reconciles-them.md#probe-2026-11-21-vector-indexes-in-sql-server-2025-in-docker)).
- Azure SQL Database makes the index with no preview feature, on the `bigint` `_elt_row` of the raw table, and the `MERGE` of each commit works on the indexed table ([ADR 0013, Azure probe](./docs/adr/0013-a-computed-dataset-declares-its-indexes-and-the-destination-reconciles-them.md#probe-2026-11-21-vector-indexes-on-azure-sql-database)).
- Each table with a vector index has its search in `marts`, an inline table-valued function named after the reader view of the table with `_nearest`: `marts.staff_passage_vectors_nearest(@query VECTOR(1536), @k INT)`. It gives the `k` nearest rows of the raw table, each with its key and its `distance`, and, for the parts table of a `TableRule`, `marts.<name>_parts_nearest` gives the key, `seq` and `distance` of each part. Its body is `SELECT TOP (@k) WITH APPROXIMATE … FROM VECTOR_SEARCH(TABLE = [_warehouse].[raw_<name>] …) ORDER BY distance` with the metric of the index, because `VECTOR_SEARCH` uses the index only on a base table, and readers read only `marts` ([ADR 0014](./docs/adr/0014-each-vector-index-has-a-search-function-in-marts.md)). A row with no vector, such as a failed one, is not in the result. Each refresh writes the `MS_Description` of the function and of its columns from the declaration: the dataset, the metric, the vector column and its type. `marts.catalog` lists the function, each parameter with its type (`@query` with `vector(n)`, `@k` with `int`) and each column that it gives. The join to other rows of `marts` can be in the same query, and the plan keeps the index:

```sql
SELECT p.id, p.text, n.distance
FROM marts.staff_passage_vectors_nearest(CAST(@q AS VECTOR(1536)), 10) AS n
JOIN marts.staff_passages AS p ON p.id = n.id
ORDER BY n.distance;
```

- Each refresh, after the indexes, makes the function, makes it again with `CREATE OR ALTER` when its stored definition differs, such as after a change of the metric or of the dimensions, and drops it when the table has no vector index. A table has at most one vector index, and its key cannot be named `distance`; the constructor refuses both with a `TypeError`. A copy whose reader name is the name of the function fails the pipeline before anything is made.
- The function and the raw table have one owner, so a reader that may read the function reads it with no permission on `_warehouse`: `GRANT SELECT ON SCHEMA::marts` covers each function of `marts`. The `readers` of `SqlServerSyncHistory` get `SELECT` on the numbering of `_warehouse` only.
- The function searches the rows of now: the raw table, also inside a reading as of an older position. A search as of a position reads the reader view `marts.staff_passage_vectors` in a reading, with `VECTOR_DISTANCE`, which is exact and uses no index. `VECTOR_SEARCH` through the reader view, a `UNION ALL` of the raw table and its history, also runs as an exact scan.
- The optimizer of Azure SQL chooses between the index and an exact scan by cost: a small table, or an index whose graph is not built yet, is searched exactly.
- SQL Server 2025 in Docker parses no `TOP … WITH APPROXIMATE` (error 102), and refuses the vector index before the function, so the function exists only on Azure SQL; the tests check its refusals and its drop there.
- See the recipe [Chunk documents, embed each chunk and search them with a vector index](./docs/recipes/search-chunks-with-a-vector-index.md).

## Files

SQL Server takes the same `text().from(file).parse(parser)` and `text().from(file.store(storage))` declarations as SQLite and Postgres. See [stored files](../../elt/README.md#stored-files-and-document-parsing) in elt.

- Parsed content is `NVARCHAR(MAX)`. A reference to a file of a storage is `NVARCHAR(MAX)` too.
- A plain `blob()` column stores an inline `VARBINARY(MAX)` value. Its bytes go to the server as base64 text in the JSON batch, which `OPENJSON` reads as `varchar(max)`: `BASE64_DECODE` does not take `nvarchar` (error 8116, [ADR 0011](./docs/adr/0011-a-batch-travels-as-one-json-parameter-that-openjson-reads.md)).

`destination.files()` gives a [database file storage](../../elt/README.md#files-in-the-database): the copy stores each file in the database, and a `DocumentText` reads it from there, so a writer whose container gets a fresh disk keeps its files.

```ts
const documents = destination.table('documents', (c) => [
  c.text('id'),
  c.text('documentRef').from(source.driveItems.file.store(destination.files())),
]);
new DocumentText({
  parser: () => parser,
  files: destination.files(),
  column: 'documentRef',
});
```

- The table is `_warehouse._elt_files`, which readers of `marts` do not see: `[scope] char(64)`, the SHA-256 of the scope; `[name] varchar(128)`, the SHA-256 of the bytes and the short source extension; `[n] bigint`, the place of the chunk from 0; and `[bytes] varbinary(max)`, at most 4 MiB. The key is `([scope], [name], [n])`. The first call of the storage makes the schema and the table.
- `[scope]` and `[name]` compare by their bytes (`COLLATE Latin1_General_BIN2`), so `a.PDF` and `a.pdf` of the same bytes stay two files in a database whose collation ignores case ([ADR 0015](./docs/adr/0015-the-file-storage-compares-the-names-of-its-files-by-their-bytes.md)).
- Each chunk goes as base64 in one JSON parameter, as a plain `blob()` does.
- The ref is `<scope hash>/<name>`. The `MS_Description` of the ref column begins with the `reference` of the storage: "Name of a copy of the source file bytes in table _warehouse._elt_files of this database: the SHA-256 of its scope, a slash, and the SHA-256 of the bytes with a short source extension. Kept only while a row references it. Not the source file name, a URL or extracted text."
- Each call opens a session of its own with the login of the destination. A save commits each chunk on its own, before the rows that name the file commit. The reconcile keeps each file that a row of the target, of its history or of the hidden target of a reload names.
- A ref that the table does not hold fails the row of a `DocumentText` with `Table _warehouse._elt_files has no stored file <ref>. Reload the copy that stored it to store the file again.` A login without a permission is a `config` failure, as for the destination.
- Recipe: [store files in the database and read their text](./docs/recipes/store-files-in-the-database-and-read-their-text.md).

## Descriptions

The descriptions of the source become `MS_Description` extended properties of each table, view and column (`sp_addextendedproperty`, `sp_updateextendedproperty`), the property that SQL Server Management Studio and the SQL Server source of elt read. The rules are those of [elt-postgresql](../postgresql/README.md#descriptions). An extended property holds at most 7,500 bytes; a longer description fails the declaration of the copy before a connection reads.

## Locks and commits

- As in Postgres, a load takes no schema lock, and no transaction stays open between commits. Each commit is one short transaction.
- Readers never wait for a load: with `READ_COMMITTED_SNAPSHOT` on, a reader reads the last committed version of each row. A `DELETE` or a `MERGE` that escalates to a table lock does not block them.
- Before the commits of a load, the writer makes the tables that the targets of one database share in `_warehouse`, when they are not there, in a transaction of its own that holds a transaction lock of `sp_getapplock` on `_warehouse`, as in Postgres. No commit holds that lock. The publication and the withdrawal of a view take the lock of `marts` ([ADR 0009](./docs/adr/0009-each-lock-is-an-application-lock-of-sql-server.md)).
- The open of a load takes a transaction lock of `sp_getapplock` on `_warehouse._elt_loads` before it inserts the row of the load, so the opens of a database take turns. The open closes each open load of its owner with an `UPDATE`, which reads each row of the table with an update lock, because the owner is `NVARCHAR(MAX)` and has no index. Without the lock, two connections of one pipeline that open their loads at the same time each hold the row that it inserted and wait for the row of the other, and SQL Server stops one of them with error 1205 ([ADR 0009](./docs/adr/0009-each-lock-is-an-application-lock-of-sql-server.md)).
- A commit applies the retention in its own transaction (see "Commit numbers and positions" below). It deletes the commits before `min_valid` by a range of the rowversion, which seeks the primary key, so it reads no commit row of another commit. It deletes the closed loads that have no commit `WITH (READPAST)`, so it skips each row of `_elt_loads` that another transaction holds, such as the row that an open inserted; the retention of a later commit deletes a load that it skipped. Without them, two commits that apply the retention at once, or a retention and an open, wait for each other, and SQL Server stops one with error 1205 ([ADR 0009](./docs/adr/0009-each-lock-is-an-application-lock-of-sql-server.md)).
- A deduplicating commit merges the stage of one stream into its table with one `MERGE` on `_elt_key_hash`. The result is the same as when the operations apply one at a time, as in Postgres. The `OUTPUT` of the `MERGE` gives each row that it updated or deleted, and the same statement inserts them into the history ([ADR 0005](./docs/adr/0005-a-commit-is-one-merge-whose-output-keeps-the-replaced-rows-in-the-history.md)). See "Deduplication" below.
- An overwrite replaces the rows by difference with `DELETE`, not `TRUNCATE`: `TRUNCATE` takes a schema modification lock, and readers wait for it. The rows of the table and the records of the commit match as multisets of row hashes: the k-th row with a hash matches the k-th record with that hash, by the order of `_elt_row` and of the stage. A row with no match goes, and the same statement keeps it in the history (`INSERT INTO <history> SELECT … FROM (DELETE … OUTPUT deleted.*)`). A row with a match stays with its `committed_in` and its `loaded_at`. A record with no match enters. An `overwrite_dedup` matches only the record of each key that its reduced stage keeps. A reset deletes its scope in the same way.
- A row is told apart by `_elt_row`, its identity number, where Postgres uses `ctid` and SQLite uses `_rowid_` ([ADR 0003](./docs/adr/0003-a-raw-table-numbers-its-rows-with-an-identity-column.md)).
- The writer of each table is in `_warehouse._elt_writers`, by the [target ownership](../../elt/README.md#target-ownership) rule.

Shape changes:

- When the columns, types or `NOT NULL`s of a stored table do not fit the stream, and the copy does not overwrite, the load evolves the table in place before it reads, in one commit of its own: `ALTER TABLE … ADD` a nullable column, `DROP COLUMN`, and `ALTER COLUMN … type`. Before a conversion, each stored value that is not null must convert back to itself (`TRY_CAST(TRY_CAST(column AS new) AS old) = column` for each row), so `1.5` in `FLOAT` fails the load to `BIGINT` and names the column. A conversion from `NVARCHAR(MAX)` is the parse that the load applies to each new value, so it has no check, and a value that it cannot parse fails the `ALTER`. A failure leaves the table as it was. The `CHECK` of an array column goes before an `ALTER` or a `DROP` of its column, and comes back for a column that is an array after the change. `VECTOR` converts only to and from text, so a change of the dimensions of a rule column makes the raw table again.
- A row with a value in a column that the evolve drops or converts loses or changes the value, so it is a new version in the commit of the evolve: the history keeps the row as it was, and the row hash of the row becomes `NULL`, which matches no record until a commit writes the row again. A column that the evolve adds is `NULL` in each row, which a row hash does not count, so it makes no new version. An evolve that keeps no row and expires no position takes back its commit row.
- The history follows the evolve: it takes each new column, nullable, keeps each dropped one, and converts its column for a widening, so each position stays readable. Any other change of type expires each position before the commit of the evolve (see "Commit numbers and positions" below).
- The stored key hashes cannot be made again from the stored rows. Thus an evolve of a table whose key or key types changed fails the copy, with no change to the table; clear the copy to load it again.
- A change waits at most 3 seconds for readers (`SET LOCK_TIMEOUT 3000`), because `ALTER COLUMN` takes a schema modification lock, which also blocks readers that use row versions. Then it fails the copy until the next run.
- A reload goes into a hidden table `_elt_next_<hash>`, which readers do not see, and no commit into it keeps a row in the history. The end of the reload gives its rows to the table by difference when the shapes agree, as an overwrite replaces its rows, and swaps it in when they do not. A reload that fails continues at the next run, and a new `RESET` starts it again.
- A `RESET` of a partition reloads only that partition, as Delta Lake's `replaceWhere` replaces only the rows of its condition ([elt ADR 0024](../../elt/docs/adr/0024-a-reset-of-a-partition-reloads-it-into-a-hidden-target.md)). The rows of the reloaded partitions go to the hidden table, the rows of the others go to the table, and a deletion whose key does not name its partition goes to both. `_warehouse._elt_reloads` keeps the partitions of an open reload, so a run that continues it reloads the same ones. A partition condition compares text in a binary collation, so `a` and `A` are two partitions.
- The swap is one transaction, and it waits for readers as a change does. It gives the rows of the hidden table the number of the commit, keeps each row of the old table in the history, renames the old table and then the hidden table with `sp_rename`, and drops the old table. The history takes each new column, nullable, and converts its column for a widening. Any other change of the type of a column that the history keeps drops the history and expires each position before the swap, because the history holds one type for each column. The swapped-in table takes the grants of the old one, as Snowflake's `COPY GRANTS` does, and `CREATE OR ALTER VIEW` defines the reader view again over the new columns, with its grants.
- The views over the table read the new table after the change: SQL Server finds the tables of a view by name, so the destination only runs `sp_refreshview` for each of them. A change that a view `WITH SCHEMABINDING` stops, such as a swap, fails, and the destination names the schema-bound views in its error; an added column goes through ([ADR 0006](./docs/adr/0006-a-change-of-a-table-refreshes-the-views-over-it.md)).

## Deduplication

An `append_dedup` copy keeps one row for each key, as in [elt-postgresql](../postgresql/README.md#locks-and-commits). The key is the key of the stream, or the `primaryKey` of the copy.

- The stage keeps each operation in the order of the source: a record, or a deletion of its key (`_elt_op`). A deletion carries the key values and its key hash, and no row hash.
- The rows match by `_elt_key_hash`, the SHA-256 of the JSON array of the key values, with a unique index on it. Thus two keys that differ only in case, such as `A` and `a`, stay two rows ([ADR 0004](./docs/adr/0004-a-key-is-indexed-by-its-hash.md)).
- A commit first reduces its stage to one operation for each key hash, as if the operations applied one at a time: only the operations after the last deletion of a key count, and a deletion with no record after it removes the key. `replace` keeps the last record. `cursor_newer` keeps the first record with the greatest cursor.
- Then one statement changes the table and keeps the history: `INSERT INTO <history> SELECT … FROM (MERGE <table> USING <reduced stage> … OUTPUT deleted.*) WHERE committed_in IS NOT NULL` ([ADR 0005](./docs/adr/0005-a-commit-is-one-merge-whose-output-keeps-the-replaced-rows-in-the-history.md)). A deletion deletes its row. A record after a deletion of its key replaces the row. Another record replaces the row when its row hash differs and, for `cursor_newer`, when its cursor is greater than the cursor of the row. A record of a new key is inserted. An inserted row outputs a `deleted` row of nulls, which the history does not keep.
- A record with the row hash of the stored row leaves the row, its `loaded_at` and its `committed_in` as they are, and the history keeps nothing. A commit that changes no row takes back its commit row, so it gives no position.
- A text cursor compares by its UTF-8 bytes: `CONVERT(varchar(max), cursor COLLATE Latin1_General_100_BIN2_UTF8)`, as `COLLATE "C"` does in Postgres. Thus `B` comes before `a`, and `Ａ` (U+FF21) comes before an emoji.
- The index of the key hash is named after the table, its key and the types of the key (`_elt_key_<hash>`). After a checkpoint reset that gives the copy another key, or a change of the type of a key field, the stored hashes are of the old key values, so the table no longer fits, and the copy fails with no change to the table; clear the copy to load it again.
- A stored row with a null key or cursor fails the load with `Existing deduplication keys and cursors must be non-null`, as in Postgres.

## Commit numbers and positions

One numbering orders the commits of the whole database, in the schema `_warehouse`, as in Postgres. The tables and the rules are those of [elt-postgresql](../postgresql/README.md#commit-numbers-and-positions): `_elt_commits`, `_elt_loads`, `_elt_epoch` with `min_valid` and `expired_by`, positions `<epoch>:<number>`, the history of each table, the widening rule, retention, and the clear that forgets.

How SQL Server is different:

- A commit number is the `rowversion` of the commit's row in `_elt_commits`, which the commit inserts before it changes a row. `MIN_ACTIVE_ROWVERSION()` gives the lowest number that a transaction still holds, so each number below it is settled: the high-water mark is `MIN_ACTIVE_ROWVERSION() - 1`. No lock and no sequence is necessary ([ADR 0002](./docs/adr/0002-a-commit-number-is-the-rowversion-of-its-commit-row.md)).
- Numbers are not dense. Writes of other `rowversion` columns of the database and commits that rolled back are gaps, which a reader skips, as in Postgres.
- A transaction that changes no row deletes its commit row before it commits, so it takes no number that a reader sees.
- The widenings of SQL Server, which `ALTER COLUMN` converts with no loss: `BIGINT`, `BIT`, `DATE`, `DECIMAL`, `DATETIME2`, `DATETIMEOFFSET` and `TIME` to `NVARCHAR(MAX)`; `BIGINT` to a `DECIMAL(p, s)` with p − s ≥ 19; `DATE` to `DATETIME2`; `DATETIME2`, `DATETIMEOFFSET` and `TIME` to more digits of a second; `DECIMAL(p, s)` to a `DECIMAL(q, t)` with t ≥ s and q − t ≥ p − s. `FLOAT` does not widen to text, because the conversion keeps 6 digits; `VARBINARY` and `JSON` do not either. `BIGINT` does not widen to `FLOAT`, because past 2^53 it loses digits. Any other change of type sets `min_valid`, as in Postgres.

A reading as of a position:

- Each reader view reads its table as of the position in `SESSION_CONTEXT(N'elt.position')`: the rows of the table with `committed_in <= P`, and the rows of the history with `committed_in <= P < replaced_in`. A session that sets nothing reads the table as it is now. A view built on a reader view reads as of the same position ([ADR 0010](./docs/adr/0010-a-reading-sets-its-position-in-the-session-context-and-reads-row-versions.md)).
- `await destination.reading(position?)` gives `{ sql, position, at }` or `{ expired }`, as in Postgres. With no position, it reads the newest position. `sql` is a `SqlServerConnection` of its own session, in a `SNAPSHOT` transaction, so a commit after the reading begins shows in no read. Dispose the reading to end the session.
- The position is a read-only key of the session context, so the reader cannot change it: a change fails with error 15664. Below the newest commit that the snapshot sees, the key holds the number of the position. At the newest commit, it holds the largest `bigint`, which reads each table as it is now, because a key with no value cannot be read-only ([ADR 0010](./docs/adr/0010-a-reading-sets-its-position-in-the-session-context-and-reads-row-versions.md)).
- A position of another epoch, past the newest commit, or before `min_valid` gives `{ expired }` with the reason, such as a clear that forgot the rows. A commit inside a pass, or a text that is not a position, is a `TypeError`.

## Checkpoints

`SqlServerCheckpointStore({ login })` keeps the checkpoints of every connection in `_warehouse._elt_checkpoints`, beside the data, as in Postgres. The key is the id of the copy, so the copy ids of every connection of the database must be different. `binding` and `state` are `NVARCHAR(MAX)`, which keeps each UTF-16 code unit, also `\u0000` and lone surrogates; the `JSON` type would refuse such text. The store holds one session lock for each copy `id` through `SqlServerStore` of `@zukhruf/mutex/sqlserver`, as `SQLiteCheckpointStore` holds one through `SqliteStore` of `@zukhruf/mutex/sqlite`. A run that finds one ID in use fails with `Checkpoint <id> is in use by another run`. The server releases a session lock when the session ends.

## Reader views

As in [elt-postgresql](../postgresql/README.md#reader-views): `table(name)` names the view `marts.<name>` over `_warehouse.raw_<name>`. `committed_in`, `_elt_row`, `_elt_row_hash`, `_elt_key_hash` and `replaced_in` are internal, and the reader view does not show them.

## Declare a view

As in [elt-postgresql](../postgresql/README.md#declare-a-view). The view lives in `marts`, and the bare names of its SQL are found in `marts`, as in Postgres. Thus the SQL reads the reader views. SQL Server resolves a bare name inside a view through the schema of the view and then `dbo`, for each user; the default schema of the user takes no part ([probe of 2026-11-20](./docs/adr/0006-a-change-of-a-table-refreshes-the-views-over-it.md#probe-2026-11-20-a-bare-table-name-inside-a-view)). Name a relation of another schema with its schema, such as `_warehouse.raw_drive_items`. A missing relation is error 208 (`Invalid object name`), and the view waits only when the pipeline makes that relation: a reader view or a raw table of a copy into the same database, or a view declared before it. A view over a relation that the pipeline does not make, or over a view declared after it, fails the refresh with the error of SQL Server.

- A refresh compares the stored definition (`OBJECT_DEFINITION`) with the new text, from the name of the view to its end: SQL Server keeps `CREATE OR ALTER VIEW` as `CREATE   VIEW` (probe of 2026-11-20). When they are the same, it leaves the view as it was. When they differ, `CREATE OR ALTER VIEW` changes the view in place, so it keeps its object and its grants, and `sp_refreshview` refreshes each view over it, so a view over `*` shows the new columns ([ADR 0006](./docs/adr/0006-a-change-of-a-table-refreshes-the-views-over-it.md)).
- A view that the refresh makes again must have exactly the columns that the declaration describes. The descriptions become `MS_Description` extended properties. A view over `*` gets a new column of its table when the change of the table refreshes it, and the next refresh of the view then writes the description of that column.
- While a view waits, its refresh drops the view of its name that an earlier declaration made, and each view over it, deepest first, as elt-postgresql drops a view with `CASCADE`. SQL Server keeps a view over a dropped view, and each read of it then fails with error 4413, so the refresh drops that view too. A view of the pipeline over it waits, or is made again by its own refresh. A view that someone made over it is gone.
- The publication and the withdrawal take the lock of `marts`, each in a transaction of its own.

## Declare a computed dataset

As in [elt-postgresql](../postgresql/README.md#declare-a-computed-dataset). A computed dataset keeps one output row for each key, in the table `_warehouse.raw_<name>`, beside its history. Readers query the view `marts.<name>`. The columns are the key, `input_hash`, `rule`, `status`, `error`, and the columns of the rule. A `text` column of a rule is `NVARCHAR(MAX)`, an `integer` column is `BIGINT`, a `blob` column is `VARBINARY(MAX)`, and a `vector(n)` column is `VECTOR(n)`. The key is `NVARCHAR(MAX)`, and the table is unique on the hash of the key ([ADR 0004](./docs/adr/0004-a-key-is-indexed-by-its-hash.md)). The refresh, its commits, its positions and its status follow elt-postgresql.

- The raw table also has `_elt_row`, its clustered key ([ADR 0003](./docs/adr/0003-a-raw-table-numbers-its-rows-with-an-identity-column.md)), `committed_in`, `_elt_row_hash` and `_elt_key_hash`. The constructor refuses a rule column whose name is one of these, the key, an engine column or `replaced_in`, or the name of another rule column, without case, as SQL Server compares two names.
- Each settled call of the rule is one commit: one `MERGE` on `_elt_key_hash` of the rows whose row hash changed, whose `OUTPUT` the history keeps ([ADR 0005](./docs/adr/0005-a-commit-is-one-merge-whose-output-keeps-the-replaced-rows-in-the-history.md)). A row whose values did not change keeps its commit, and a call that changes no row takes no commit number. The row hash counts a vector by its JSON text.
- When the stored columns of the raw table differ from its declaration, for example a vector of other dimensions, the refresh makes the table again in one commit: the history keeps each old row and takes the new shape, `CREATE OR ALTER VIEW` keeps the reader view, and `sp_refreshview` refreshes each view over it ([ADR 0006](./docs/adr/0006-a-change-of-a-table-refreshes-the-views-over-it.md)). A column whose type the history cannot widen, such as `VECTOR(3)` to `VECTOR(4)`, expires each position before that commit, as a reload of a stream does.
- The dataset reads each relation of `from` through its reader view in one statement. A table of `from` must be loaded by a copy into the same database.
- `qualifiedName` is `marts.<name>`. A `View` declared after the dataset that reads it waits while the dataset waits.
- `indexes` declares the indexes of the raw table: `{ type: 'nonclustered', columns }` or `{ type: 'vector', column, metric }` (see "Store vectors" above). The constructor refuses, with a `TypeError`, a column that the table does not have, a vector index on a column that is not a vector, and an index key that SQL Server refuses: `NVARCHAR(MAX)`, `VARBINARY(MAX)` or `VECTOR` (errors 1919 and 1978). Thus of the engine columns only `committed_in` can be a key.
- The destination names each index `ix_elt_` and the first 16 hex digits of the SHA-256 of its declaration. Each refresh, before it writes a row, reads the indexes of the table with that start from `sys.indexes`, drops each one that is no longer declared and makes each declared one that is missing, one statement at a time and outside a transaction, since SQL Server makes a vector index only there. No row is written or computed again, and an index of another name, such as a person's own, stays ([ADR 0013](./docs/adr/0013-a-computed-dataset-declares-its-indexes-and-the-destination-reconciles-them.md)). A person's index is gone after a changed declaration makes the table again; a declared one is made again.

A `TableRule` gives many parts for one input, as in [elt-postgresql](../postgresql/README.md) and [elt ADR 0026](../../elt/docs/adr/0026-a-rule-can-give-many-parts-for-one-input.md). The raw table then keeps one output row for each key, with no rule column, and the parts table `_warehouse.raw_<name>_parts` keeps one row for each part. Readers query the view `marts.<name>_parts`: the key, `seq` (`INT`, from 0), `part_hash` (`NVARCHAR(MAX)`), the content columns and the place columns.

- The parts table also has `_elt_row`, its clustered key, `committed_in`, `_elt_row_hash` and `_elt_key_hash`. It is unique on `_elt_key_hash` and `seq`, because the key is `NVARCHAR(MAX)` (ADR 0004). The key hash of a part is the key hash of its output row.
- The commit of a settled call writes the output rows and their parts. A part whose row hash did not change keeps its commit. The changed parts are one `MERGE` on `_elt_key_hash` and `seq`, and the parts beyond the new count of their row are one `DELETE`; the history keeps each part that they replace or remove. A row that is `empty` or `failed` has no parts, and a removed input removes its parts in the commit that removes its output row.
- The two tables are one declaration: when either one differs from its declaration, the refresh makes both again in one commit, and `sp_refreshview` refreshes the views over each.
- `partIndexes` declares the indexes of the parts table, as `indexes` does for the raw table. Only a `TableRule` takes it.
- The constructor refuses a column of the rule named `seq` or `part_hash` as well, in any case. `validate` refuses a copy that makes `<name>_parts` or `raw_<name>_parts`.
- `derived_status` counts the output rows, one for each key, not the parts.

## When something fails

As in [elt-postgresql](../postgresql/README.md#when-something-fails). Also:

- A database with no row versioning for readers fails the first load with the failure type `config`.
- An engine older than SQL Server 2025 fails the first load with the failure type `config`.
- A value that a column refuses fails its commit. The error names the column and the key.
- A vector of other dimensions than its rule column fails its output row, with an error that names both counts. The run and the other rows succeed.

## Sync history

`SqlServerSyncHistory({ login, readers })` is the sync history of a pipeline that loads into SQL Server, with the tables, views and rules of [elt-postgresql](../postgresql/README.md#sync-history): `_warehouse.sync_attempts`, `extraction_coverage`, `stream_checks` and `derived_status`, and the views `sync_attempts`, `extraction_coverage`, `sync_status`, `stream_status`, `derived_status` and `catalog` in `marts`. `install()` makes them in one transaction. `readers` are database users or roles; each install grants them `SELECT` on the numbering and nothing else of `_warehouse`. Each attempt has a session of its own that holds a session lock of `sp_getapplock` on the attempt, so the next attempt of its connection finds a pass whose process stopped and records it as `failed` (elt-postgresql ADR 0009). The `catalog` reads the `MS_Description` extended properties. It lists each view and each inline table-valued function of `marts` with its columns, and each parameter of a function as `function.@parameter` with its type; `kind` is `view`, `function`, `parameter` or `column`. A parameter has no description: the description of its function tells what it is. The sync history keeps no row versions, so a session that reads as of a position before the newest commit fails each of its views with error 245 and the message `The sync history cannot be read as of a position: it keeps no row versions`; a reading at the newest commit reads them. `readPassStatus(login)` gives the latest pass of the database and the latest outcome of each stream, as it does for Postgres. It reads them in one statement, so it needs no `SNAPSHOT` transaction, and it reads the failed passes of a database that keeps no row versions.

## Derived status

As in [elt-postgresql](../postgresql/README.md#derived-status), from elt ADR 0025: one row of `_warehouse.derived_status` for each view and computed dataset, named with its schema, which readers see as `marts.derived_status`. The sync history makes the table and the view, and a dataset makes the table too when the database has none. A `View` writes its row through `DerivedStatus` of elt, in a transaction of its own that holds the lock of `_warehouse`; the row of `marts.record_count` has the dataset `marts.record_count`. `ComputedDataset` writes its rows in the same way, and takes the settled inputs off `pending` inside the transaction of each commit, with `GREATEST(pending - count, 0)`.

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
| `@zukhruf/testing`                 | `SqlServer`, the database of the tests (SQL Server 2025 in Docker; its DiskANN index is a preview that needs an `int` clustered key, so the tests run the exact search only)                                                                                                                                                  |

## Ezz's rulings

Of 2026-11-19, except where a ruling gives another date.

1. **The order.** The SQL Server destination is built last. First the rules that the destinations share move into elt, from the two copies and checked against this paper; then the open defects and the gaps ([ADR 0012](./docs/adr/0012-the-rules-that-the-destinations-share-move-into-elt-before-the-third-destination.md)).
2. **The value of a vector column** is a `Vector` of `@zukhruf/vectors`, and `@eltjs/elt` takes that package ([ADR 0007](./docs/adr/0007-a-rule-column-can-be-a-vector-with-a-fixed-number-of-dimensions.md)).
3. **The login.** The destination takes the `SqlServerDatabase` of `@eltjs/sdk-microsoft-sql-server`, and the SDK gets write sessions.
4. **The type of a vector column.** `@zukhruf/vectors` gives the type for a kind of vector and a count of dimensions, such as `sqlType(Vector, 1536)`.
5. **Indexes.** A computed dataset declares its indexes, and the destination reconciles them with `sys.indexes` at each refresh; `afterCreate` is removed (2026-11-21, [ADR 0013](./docs/adr/0013-a-computed-dataset-declares-its-indexes-and-the-destination-reconciles-them.md), which supersedes [ADR 0008](./docs/adr/0008-a-computed-dataset-runs-the-sql-of-the-host-each-time-it-makes-its-raw-table.md)).
6. **Keys.** A unique index on `_elt_key_hash` ([ADR 0004](./docs/adr/0004-a-key-is-indexed-by-its-hash.md)).
7. **The release.** The package is public after its tests pass, so the next green push of `main` publishes it, and datahub installs it from npm.

## Probes

Each decision above that depends on the behavior of the server has a probe, whose output is in its ADR. The first seven ran on 2026-11-20, on Azure SQL Database (datahub BILLING) and on SQL Server 2025 (RTM-CU11) in Docker, except where a line says otherwise. Two results corrected a decision: ADR 0006 (a schema-bound view) and ADR 0002 (the mark of a database copy on Azure SQL Database).

- Done: `MIN_ACTIVE_ROWVERSION()` read before a `SNAPSHOT` transaction: a commit at or below the mark is always visible to the snapshot. Holds ([ADR 0002, probe](./docs/adr/0002-a-commit-number-is-the-rowversion-of-its-commit-row.md#probe-2026-11-20-the-high-water-mark-and-a-snapshot-transaction)).
- Done: `MERGE` with `OUTPUT` into the history, through composable DML, on a table with a `VECTOR` column and a DiskANN index. Holds; the index was on Azure SQL only, because SQL Server 2025 in Docker has none ([ADR 0005, probe](./docs/adr/0005-a-commit-is-one-merge-whose-output-keeps-the-replaced-rows-in-the-history.md#probe-2026-11-20)).
- Done: `OPENJSON … WITH (v NVARCHAR(MAX) '$.v')` with `CAST(v AS VECTOR(1536))` for a batch of 64 vectors. Holds; a base64 column must be `varchar(max)` for `BASE64_DECODE` ([ADR 0011, probe](./docs/adr/0011-a-batch-travels-as-one-json-parameter-that-openjson-reads.md#probe-2026-11-20)).
- Done: `sp_rename` of a table while a view reads it, then `sp_refreshview`; and the error of a `SCHEMABINDING` view. The refresh holds; a `SCHEMABINDING` view stops a swap, a drop and a change of a column that it reads, but not an `ADD` or a change of a column that it does not read, so ADR 0006 now says the destination names those views in its own error ([ADR 0006, probe](./docs/adr/0006-a-change-of-a-table-refreshes-the-views-over-it.md#probe-2026-11-20-sp_rename-sp_refreshview-and-schemabinding)).
- Done: `is_read_committed_snapshot_on` and `snapshot_isolation_state` of the datahub database. Both on ([ADR 0010, probe](./docs/adr/0010-a-reading-sets-its-position-in-the-session-context-and-reads-row-versions.md#probe-2026-11-20)).
- Done: How SQL Server resolves a bare table name inside a view in the schema `marts`, when the user that runs the query has another default schema. The schema of the view, then `dbo`, never the default schema of the user; the user with another default schema ran in Docker only ([ADR 0006, probe](./docs/adr/0006-a-change-of-a-table-refreshes-the-views-over-it.md#probe-2026-11-20-a-bare-table-name-inside-a-view)).
- Done: Whether a point-in-time restore of Azure SQL changes `recovery_fork_guid` in `sys.database_recovery_status`, so a restored database can start a new epoch. First in Docker (Ezz, 2026-11-19): on SQL Server 2025 each restore changes it and the numbers repeat after the restore point; Azure SQL Database has no `sys.database_recovery_status` ([ADR 0002, probe](./docs/adr/0002-a-commit-number-is-the-rowversion-of-its-commit-row.md#probe-2026-11-20-recovery_fork_guid-after-a-restore)). A point-in-time restore on Azure SQL Database (a scratch server in Ezz's own subscription, Ezz, 2026-11-20) changes `database_id`, `create_date` and `physical_database_name` of `sys.databases`, which a plain database user can read, and the numbers repeat; the rename to the original name keeps `database_id` and `physical_database_name`, and a change of service objective also changes `physical_database_name`. On Azure SQL Database the epoch keeps all three and starts a new epoch when any one changes, because a missed restore gives wrong rows and a needless new epoch only a full read ([ADR 0002, probe](./docs/adr/0002-a-commit-number-is-the-rowversion-of-its-commit-row.md#probe-2026-11-20-an-azure-sql-database-point-in-time-restore)).
- Done: A vector index of a computed dataset on Azure SQL Database (a scratch server in Ezz's own subscription, 2026-11-21), through a real pipeline: the DiskANN index on the `bigint` `_elt_row`, the `MERGE` and its `OUTPUT deleted.*` on the indexed table, the names in `sys.indexes`, a change of the metric on a filled table with no recompute, and a reading as of a position. Each holds. `VECTOR_SEARCH` through `marts.<name>` runs with no index, so the search reads the raw table ([ADR 0013, Azure probe](./docs/adr/0013-a-computed-dataset-declares-its-indexes-and-the-destination-reconciles-them.md#probe-2026-11-21-vector-indexes-on-azure-sql-database)).
- Done: The search function of a vector index on Azure SQL Database (a scratch server in Ezz's own subscription, 2026-11-21): an inline table-valued function with `SELECT TOP (@k) WITH APPROXIMATE` over `VECTOR_SEARCH` on the raw table keeps the `Vector Index Seek`, also when the caller joins a reader view, and a user with `SELECT` on `marts` only calls it and may not read `_warehouse`. A real pipeline then made the function with its index, made it again for a new metric, and dropped it with the index ([ADR 0014, Azure probe](./docs/adr/0014-each-vector-index-has-a-search-function-in-marts.md#probe-2026-11-21-a-search-function-on-azure-sql-database)).

## Recipes

- [Load a stream into SQL Server and read it as of a position](./docs/recipes/load-a-stream-and-read-it-as-of-a-position.md)
- [Chunk documents, embed each chunk and search them with a vector index](./docs/recipes/search-chunks-with-a-vector-index.md)
- [Store files in the database and read their text](./docs/recipes/store-files-in-the-database-and-read-their-text.md)

## Decisions

- [ADR 0001](./docs/adr/0001-the-sql-server-destination-takes-the-declarations-of-elt-postgresql.md): the SQL Server destination takes the declarations of elt-postgresql.
- [ADR 0002](./docs/adr/0002-a-commit-number-is-the-rowversion-of-its-commit-row.md): a commit number is the rowversion of its commit row.
- [ADR 0003](./docs/adr/0003-a-raw-table-numbers-its-rows-with-an-identity-column.md): a raw table numbers its rows with an identity column.
- [ADR 0004](./docs/adr/0004-a-key-is-indexed-by-its-hash.md): a key is indexed by its hash.
- [ADR 0005](./docs/adr/0005-a-commit-is-one-merge-whose-output-keeps-the-replaced-rows-in-the-history.md): a commit is one `MERGE` whose output keeps the replaced rows in the history.
- [ADR 0006](./docs/adr/0006-a-change-of-a-table-refreshes-the-views-over-it.md): a change of a table refreshes the views over it.
- [ADR 0007](./docs/adr/0007-a-rule-column-can-be-a-vector-with-a-fixed-number-of-dimensions.md): a rule column can be a vector with a fixed number of dimensions.
- [ADR 0008](./docs/adr/0008-a-computed-dataset-runs-the-sql-of-the-host-each-time-it-makes-its-raw-table.md): a computed dataset runs the SQL of the host each time it makes its raw table. Superseded by ADR 0013.
- [ADR 0009](./docs/adr/0009-each-lock-is-an-application-lock-of-sql-server.md): each lock is an application lock of SQL Server.
- [ADR 0010](./docs/adr/0010-a-reading-sets-its-position-in-the-session-context-and-reads-row-versions.md): a reading sets its position in the session context and reads row versions.
- [ADR 0011](./docs/adr/0011-a-batch-travels-as-one-json-parameter-that-openjson-reads.md): a batch travels as one JSON parameter that `OPENJSON` reads.
- [ADR 0012](./docs/adr/0012-the-rules-that-the-destinations-share-move-into-elt-before-the-third-destination.md): the rules that the destinations share move into elt before the third destination.
- [ADR 0013](./docs/adr/0013-a-computed-dataset-declares-its-indexes-and-the-destination-reconciles-them.md): a computed dataset declares its indexes and the destination reconciles them.
- [ADR 0014](./docs/adr/0014-each-vector-index-has-a-search-function-in-marts.md): each vector index has a search function in `marts`.
- [ADR 0015](./docs/adr/0015-the-file-storage-compares-the-names-of-its-files-by-their-bytes.md): the file storage compares the names of its files by their bytes.
