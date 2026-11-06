# @workspace/source-microsoft-sql-server

An ELT source for one SQL Server database. Each user table that the login can read becomes a stream named `<schema>.<table>`. The source needs SQL Server 2016 or later, Azure SQL Database or Azure SQL Managed Instance.

The words in this README have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

```ts
import { Connection, Pipeline } from '@workspace/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@workspace/elt-postgresql';
import { SqlServerDatabase } from '@workspace/sdk-microsoft-sql-server';
import { sqlServerCopies } from '@workspace/source-microsoft-sql-server/sql-server-copies';
import { SqlServerSource } from '@workspace/source-microsoft-sql-server/sql-server-source';

const url = 'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';
const schema = 'shop';

const database = new SqlServerDatabase(
  'Server=sql.example.com,1433;Database=shop;User Id=reader;Password=...;Encrypt=true',
);
const source = await SqlServerSource.discover(database, { schemas: ['dbo'] });
const destination = new PostgresDestination({ url, schema });

await new Pipeline({
  history: new PostgresSyncHistory({ url }),
  connections: [
    new Connection({
      name: 'sql-server',
      source,
      destination,
      checkpoints: new PostgresCheckpointStore({ url, schema }),
      steps: sqlServerCopies(source, (stream) => destination.table(stream)),
    }),
  ],
}).run();
```

## How to use it

1. Make a `SqlServerDatabase` from an ADO.NET connection string. [mssql](https://github.com/tediousjs/node-mssql) parses it. It does not read an `mssql://` URL. The connection string must name a `Database`.
2. Call `SqlServerSource.discover(database, { schemas })`. The streams are the tables of the database, so the source is discovered. A host discovers it again on each run.
3. Call `sqlServerCopies` to make one copy for each discovered table, with the sync strategy that discovery selected.
4. Connect the copies to a destination and a checkpoint store through `Connection` and `Pipeline`.

`@workspace/sdk-microsoft-sql-server` owns the database: the connection string, discovery, exact reads, Change Tracking and the values that a watch reads. The source owns the streams, their schemas and the sync strategy. The SDK and the source hold no configuration from environment variables or for a standalone app.

`sqlServerCopies` makes each stream a copy:

- A stream with a key gets an incremental `append_dedup` copy: Change Tracking, rowversion and snapshot streams.
- A stream with no key gets a full-refresh `overwrite` copy.
- The ID of each copy is `<source identity>/<schema>.<table>`, for example `sql-server:shop/dbo.orders`. The source identity is `sql-server:<database>`. Copy IDs must be different across a pipeline. Thus two databases that each have a table with the same name can be in one pipeline. See [ADR 0004](./docs/adr/0004-a-copy-id-carries-the-source-identity.md).

A table whose columns changed gets to the pipeline as a stream whose fields changed. The copy keeps its rows and its checkpoint, and the destination changes its table in place (see shape changes in [elt](../../../elt/README.md#shape-changes)). The source fills in a field that the table gained. See the sync strategies.

## Access

A read-only login is sufficient: `db_datareader`, and `VIEW CHANGE TRACKING` on each tracked table whose changes and deletions it must read. You do not have to enable a feature on the server. The source uses Change Tracking and snapshot isolation where an administrator turned them on. It reads every other table by its rowversion, by snapshot or fully.

`VIEW SERVER STATE` (`VIEW DATABASE STATE` on Azure SQL Database) is optional. With it, a watch sees each write to a table that the source reads by snapshot or fully, also to a column with no statistics. See [Watching](#watching).

- A connection string that names no `Database` is refused. Thus a read never goes to the default database of the login.
- A server that cannot be reached fails with `SqlServerUnavailableError`. It is down, it restarts or fails over, its address is wrong, or the network dropped the connection. This is a `system` failure, so a later attempt or a watch that watches again can succeed.
- A login that the server refuses fails with `SqlServerLoginError`: the credentials are wrong, the login is disabled, or it cannot open the database. This is a `config` failure, which the user must fix. The login errors that SQL Server gives while it fails over or is busy (4060, 10928, 10929, 40197, 40501, 40613) are not refusals: tedious tries them again, and then they are `SqlServerUnavailableError`.
- Both errors name the server and the database, but not the credentials.
- A column that the login cannot read (a column-level `DENY`) is left out, and the table's description names it. A primary key with such a column identifies nothing, so its table reads fully.
- A table with no readable column is not a stream.
- When a grant is revoked after discovery, only the stream of that table fails, with `SqlServerPermissionError`, which names the grant (`SELECT ON [dbo].[orders]`, `VIEW CHANGE TRACKING ON [dbo].[orders]`).
- Columns under dynamic data masking load as the login reads them: masked, unless the login has `UNMASK`. Their description says so.

## Streams

Discovery lists `sys.tables`: user tables. It does not list views, system tables, external tables, or the change tables that CDC keeps in `cdc`.

- A host can keep only some schemas (`{ schemas }`). Write each name exactly as `sys.schemas` spells it. A schema in the list that holds no table that the login can read fails discovery. Thus a misspelling, a casing that the database does not use, or a missing grant never loads less without an error.
- A column of an alias type (`CREATE TYPE ... FROM nvarchar(20)`) reads as the system type that it is built on, also when the login cannot see the alias type.
- The stream key is the table's primary key in key order, plus the `_type` field of a `sql_variant` key column.
- Descriptions come from `MS_Description` extended properties. When a column has none, the source makes one from the name and the type of the column. The table's description also tells how the stream reads the table, and which grant would let it read only changes.

| SQL Server                                                                                 | Field                                                                                                               |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `tinyint`, `smallint`, `int`                                                               | `integer`                                                                                                           |
| `bigint`, `rowversion`                                                                     | `int64`                                                                                                             |
| `bit`                                                                                      | `boolean`                                                                                                           |
| `real`, `float`                                                                            | `number` (the IEEE value, exactly)                                                                                  |
| `decimal(p, s)`, `numeric(p, s)`                                                           | `decimal`, precision `p`, scale `s`                                                                                 |
| `money`, `smallmoney`                                                                      | `decimal` (19, 4) and (10, 4)                                                                                       |
| `date`                                                                                     | `date`                                                                                                              |
| `datetime2(p)`, `datetime`, `smalldatetime`                                                | `date-time-local`, precision `p`, 3 and 0                                                                           |
| `datetimeoffset(p)`                                                                        | `date-time`, precision `p`: the UTC instant; beside it `<column>_offset`, the offset it was written with in minutes |
| `time(p)`                                                                                  | `time-local`, precision `p`                                                                                         |
| `char`, `varchar`, `nchar`, `nvarchar`, `text`, `ntext`, `xml`, `uniqueidentifier`, `json` | `string` (a uniqueidentifier in upper case)                                                                         |
| `hierarchyid`                                                                              | `string`, its path (`/1/2/`)                                                                                        |
| `geography`, `geometry`                                                                    | `string`, `SRID=<id>;` then the shape as text with its Z and M (`SRID=4326;POINT (-122.349 47.651 10 3)`)           |
| `sql_variant`                                                                              | `string`, the value as text; beside it `<column>_type`, its base type                                               |
| `binary`, `varbinary`, `image`, CLR types                                                  | `string`, base64                                                                                                    |

The formats are the string formats of [elt](../../../elt/README.md#string-formats). The driver gives `decimal` and `money` as JavaScript numbers and `datetime2` as a millisecond `Date`, and it drops the offset of a `datetimeoffset`. Thus the source selects each such column as the text that SQL Server spells, and decodes it into its canonical form. See [ADR 0002](./docs/adr/0002-each-column-is-read-as-the-text-that-sql-server-spells.md).

When a column of the table already has the name `<column>_offset` or `<column>_type`, the added field gets the next free name: `_1`, then `_2`. The description of the column names the field that holds its offset. See [ADR 0003](./docs/adr/0003-an-added-field-takes-the-next-free-name.md).

## Sync strategies

Discovery selects how each table reads. Each table reads with the first strategy that it can use:

| Strategy        | When                                                                   | Copy                          |
| --------------- | ---------------------------------------------------------------------- | ----------------------------- |
| Change Tracking | the table has a key, tracks changes, and the login can see its changes | `incremental`, `append_dedup` |
| Rowversion      | the table has a key and a `rowversion` column                          | `incremental`, `append_dedup` |
| Snapshot        | all other tables that have a key                                       | `incremental`, `append_dedup` |
| Full refresh    | the table has no key                                                   | `full_refresh`, `overwrite`   |

**Change Tracking** is for a keyed table that tracks changes, when the login has `VIEW CHANGE TRACKING`.

- The first read loads every row, 10,000 rows for each checkpoint, in primary key order. It starts from the position in the table's change history that it read before it began. A load that fails continues after its last checkpoint.
- Later reads apply each key that changed since: its row as it is now, or a `DELETE`.
- With `ALLOW_SNAPSHOT_ISOLATION` on, the position, the check and the changes come from one short snapshot transaction for each table. Without it, the source reads the position first. Thus a change made during the read is read again the next time, and the source checks the history again after the read.

**Rowversion** is for a keyed table with a `rowversion` column.

- Each read takes the rows above the last rowversion that it read, and below `MIN_ACTIVE_ROWVERSION()`. Thus a row that a transaction still writes waits for a later read.
- The source does not see deletions. A deleted row stays loaded.
- Its state records the columns that it read. A column that the table gained changes no rowversion. Thus the next read starts again from the first row, and keeps what is loaded.

**Snapshot** is for a keyed table with no Change Tracking that the login can read and no `rowversion` column. It is a snapshot stream of [elt](../../../elt/CONTEXT.md):

- Each read takes every row. The copy compares the rows with the snapshot in its checkpoint, writes each row that is new or changed, and deletes each row whose key the read did not give. The read gives every row, so a key that it does not give was deleted (the `ClosedWorld` deletion policy).
- A read that fails deletes nothing.
- A full-refresh copy of the stream replaces its target with every row.

**Full refresh** is for a table with no key, or with a key that the login cannot read in full. Each read takes every row, and the copy replaces its target.

A position in a table's change history is a Change Tracking version and the table's tracking generation. The generation is the table's `begin_version`, which a `TRUNCATE` moves to the current version, and the creation time of its change table, which enabling tracking again makes new. See [ADR 0001](./docs/adr/0001-a-change-tracking-position-carries-the-tracking-generation.md).

- The history no longer covers a saved position when the position is below the table's minimum valid version, ahead of the database's current version, or of a different generation. The stream then sends `RESET` and loads every row again into a hidden target, which replaces the table when the stream ends (see resets in [elt](../../../elt/README.md#resets)).
- The stream does the same for a column that the table gained since the state was saved, because Change Tracking reports no change for the rows to which it was added.
- The generation finds the case that the minimum valid version cannot find: a truncate just after a sync, with no change between them, leaves the minimum valid version equal to the saved one.

Pages compare the full primary key as a tuple. Each part is cast to the declared type and collation of its column. Thus a page does not skip or repeat rows that have the same leading key value, and a `varchar` key under a SQL collation orders as the column sorts.

## Watching

`observe()` checks every 30 seconds, with the `ChangeWatcher` of `@zukhruf/async`. It opens one session for the watch. Each sync strategy names the gauges of its stream, and the gauges of one stream are one group. On each check, each collector reads the values of all tables in one query, and the database version gives the Change Tracking version and the last rowversion in one query. A check wakes a stream when one gauge of its group changed. The first check wakes every stream. A check that wakes no stream yields nothing.

| Sync strategy             | Gauges                                                             |
| ------------------------- | ------------------------------------------------------------------ |
| Change Tracking           | the Change Tracking version                                        |
| Rowversion                | the last rowversion                                                |
| Snapshot and full refresh | the statistics, the row count, the last write (optional), the hour |

- **The Change Tracking version** (`CHANGE_TRACKING_CURRENT_VERSION()`) of the database, one gauge for all streams. A change to a tracked table moves it, in the transaction of the change.
- **The last rowversion** (`@@DBTS`) of the database, one gauge for all streams. An insert or an update of a row with a `rowversion` column moves it.
- **The statistics** of the table (`sys.dm_db_stats_properties`): their count, the rows changed in their columns, and the time of their last refresh. An insert, a delete, a `TRUNCATE` or an update of a column with statistics moves it. A restart keeps it. A refresh of statistics sets the count to 0 and changes the time. `db_datareader` can read it.
- **The row count** of the table (`sys.partitions`). An insert, a delete or a `TRUNCATE` moves it, also when SQL Server has not built the statistics of the table. An update does not move it. `db_datareader` can read it.
- **The last write** of the table (`sys.dm_db_index_usage_stats`): the writes and the time of the last write. Each insert, update or delete moves it, also of a column with no statistics. A `TRUNCATE` does not move it. Discovery reads it one time. When the login cannot read it, the streams do not use it, and their description names the grant.
- **The hour**: a period of one hour, the number of whole hours since the watch started. Each hour, it wakes the streams again, and the read finds a change that the other gauges did not see.

The statistics, the row count and the last write are collectors: one key for each table, by its quoted name. A table that a collector does not give, for example a table dropped after discovery, changed, so its stream wakes and its read fails.

The queries of one check have 10 seconds. When a gauge fails, for example because its query took longer, the watch fails with the error of the gauge. A restart of the SQL Server engine drops the connection of the watch, so the watch also fails. elt's pipeline watches again after a system failure, and the first check of the new watch wakes every stream.

The database is current whenever the source reads it, so the source gives no `currentAsOf`.

## Limitations

- Rowversion tables do not see deletions. A deleted row stays.
- Without the last write, an update of a column with no statistics loads only at the next hour.
- SQL Server builds the statistics of a table when a query first needs them. Until then, they count nothing. In a table that no query has read by a column since it was created empty, an insert or a delete moves the row count, and an update waits for the last write or the hour. A table with no key and no index has no statistics at all, so the same is true for it.
- The source does not read CDC (backlog #2315).
- The source discovers tables only, not views (backlog #3253).
- In one case, the source does not see a truncate, or tracking that was turned off and on again: when the table's tracking began at the version that the last sync read, and nothing that is tracked changed in the database since. No metadata that a read-only login can see changes then.
- A single value longer than the longest JavaScript string (about 512 million characters) fails its stream.

## Live checks

Run on 2026-10-06 against SQL Server 2022 CU27 (16.0.4295.3) Developer, in the compose `sqlserver` service on linux/amd64, emulated on Apple silicon, through mssql 12.7.4 and tedious 20.3.3:

- Style 126 leaves out a zero fraction (`2025-01-02T03:04:05`) and keeps every digit of any other fraction (`.1200000`). `time(p)` keeps exactly `p` digits. Style 2 spells money with four digits.
- `CHANGE_TRACKING_MIN_VALID_VERSION` gives 0, not NULL, to a login without `VIEW CHANGE TRACKING`. The `CHANGETABLE` read of that login fails with error 229. `sys.change_tracking_tables` and `MS_Description` stay visible to `db_datareader`.
- `TRUNCATE` sets the table's minimum valid version and `begin_version` to the current version. Enabling tracking again makes a new `create_date` for the change table in `sys.internal_tables`, which `VIEW CHANGE TRACKING` makes visible.
- A column-level `DENY` makes `HAS_PERMS_BY_NAME` report the full table as not readable. Thus the source checks readability for each column. A column of an alias type that the login cannot see disappears from an inner join with `sys.types`.
- A key bound as an `nvarchar` parameter and compared with a `varchar` column under `SQL_Latin1_General_CP1_CI_AS` skips rows (`co-op` before `Coat`): the two sort hyphens differently.
- `varbinary` keys ignore zero bytes at the end (`0x00`, `0x0000` and `0x` are one key).
- tedious 20.0.0 refused to connect to an IP address over TLS. 20.3.3 connects.
- `sql_variant` text under style 126 keeps times exact. Floating point needs style 3 for 17 digits.
- An end-to-end check of the source and the pipeline loaded a seeded database, read by a `db_datareader` login. On a second run, it wrote nothing to the Change Tracking and rowversion tables. On a third run, it applied an update, a deletion, a truncate and an added column.

Run on 2026-11-04 against three Azure SQL databases (General Purpose, Gen5), read only:

- `sys.dm_db_index_usage_stats` gave the time of the last write to a table to the second of its `updatedAt` column. It also gave a write on 2026-10-29 to a table whose `DateUpdated` column the write did not change. It was empty for writes before the last restart of the engine, and the three engines restarted within 9 days.
- `sys.dm_db_log_stats` moved its last log position in 15 seconds with no write by a user, so it is no signal of a table.

Run on 2026-11-06 against SQL Server 2022 in a container, through a `db_datareader` login and a login with more grants:

- A restart cleared the last writes and the row counts of `sys.dm_db_index_operational_stats`, and kept the count of `sys.dm_db_stats_properties`.
- A `TRUNCATE` moved neither the last write nor the row counts. It moved the count of the statistics.
- An update of 100 rows in a column with no statistics did not move the count of the statistics. `UPDATE STATISTICS` set the count to 0 and changed the time of the refresh.
- An `UPDATE` of no row and an `UPDATE` that was rolled back moved the last write.
- `db_datareader` could read the count of the statistics and the row counts of `sys.partitions`, and got error 297 for the last writes and the row counts of `sys.dm_db_index_operational_stats`.
- Statistics that an index created on an empty table made had no count and no time of refresh until `UPDATE STATISTICS` built them. Rows inserted before then moved only the row count.
- `CHECKSUM_AGG(BINARY_CHECKSUM(*))` read every page of the table. It did not change for a value changed from `' !'` to `''Q'`, for two rows that swapped a value, or for two equal rows added to a table with no key. A SHA-256 hash of each row found all three.

## Decisions

- [ADR 0001: A Change Tracking position carries the tracking generation](./docs/adr/0001-a-change-tracking-position-carries-the-tracking-generation.md)
- [ADR 0002: Each column is read as the text that SQL Server spells](./docs/adr/0002-each-column-is-read-as-the-text-that-sql-server-spells.md)
- [ADR 0003: An added field takes the next free name](./docs/adr/0003-an-added-field-takes-the-next-free-name.md)
- [ADR 0004: A copy ID carries the source identity](./docs/adr/0004-a-copy-id-carries-the-source-identity.md)
