# elt-sqlserver

> **Partly built.** See the banner of the [README](./README.md).

A host wants the data that elt copies in a SQL Server or Azure SQL database, with typed columns, which readers query while the loads run, and the vectors of its computed datasets in a column that Azure SQL can search. The SQL Server destination loads each stream into a raw table in `_warehouse`, keeps a reader view of each raw table in `marts`, and keeps the views and computed datasets that the pipeline derives from them. Its checkpoint store and its sync history keep their data in the same database. The words that all of elt uses, for example pass, commit, writer and checkpoint, are in the glossary of [elt](../../elt/CONTEXT.md). The words that this context shares with [elt-postgresql](../postgresql/CONTEXT.md) have the same meaning; this glossary gives each one again only where SQL Server makes it different.

## Language

**Schema**:
One of the two SQL Server schemas of a database, which the destination fixes, as in elt-postgresql. `marts` holds each relation that readers query, and each one is a view. `_warehouse` holds each table of elt: the raw tables, their histories and file chunks, the writers, the checkpoints, the numbering and the sync history. A host names no schema.
_Avoid_: Database (a database holds the two schemas), owner

**Login**:
What the destination connects with: the parts of a SQL Server login, or an ADO.NET connection string. It holds credentials, so no location names it.
_Avoid_: URL (SQL Server has no URL form that `mssql` reads), connection (a connection is one session of the login)

**Raw table**:
The table that a copy loads, `_warehouse.raw_<name>` for the reader name `<name>`, for example `_warehouse.raw_drive_items`. Readers do not query it.
_Avoid_: Staging table, source table

**Reader view**:
The view `marts.<name>` that a load keeps of its raw table, for example `marts.drive_items`. The host gives its name, the reader name, to `table`. Each copy has one. It shows the external schema of the stream: its columns and `loaded_at`. The internal columns are for the SQL of the destination only.
_Avoid_: Mart (a mart is the schema `marts`), view (a view is a derived dataset)

**Internal column**:
A column that only the SQL of the destination reads: `committed_in`, `_elt_row`, `_elt_row_hash`, `_elt_key_hash`, and `replaced_in` of a history.
_Avoid_: Hidden column (SQL Server's `HIDDEN` is a property of a period column), system column

**Row number**:
`_elt_row`, the `BIGINT IDENTITY` column that is the clustered key of each raw table and hidden table. A difference and a reload tell a row apart by it.
_Avoid_: Row id (SQLite's `rowid`), physical locator (`%%physloc%%`), ctid

**Row hash**:
`_elt_row_hash`: the SHA-256 of the values of a row, computed when the row is staged. A vector counts by the JSON text that the stage carries. A commit that finds the stored row with the same hash leaves it as it is.
_Avoid_: Checksum, `CHECKSUM()` (a 32-bit hash of SQL Server), version

**Key hash**:
`_elt_key_hash`: the SHA-256 of the key values of a row, computed when the row or a deletion of its key is staged. The unique index of a deduplicating table and of a computed dataset is on it, because a key column of `NVARCHAR(MAX)` cannot be an index key. The index is named after the table and its key, so a table whose hashes are of another key does not fit.
_Avoid_: Surrogate key (the key hash is derived from the key, not made by the store), `HASHBYTES`

**Stage**:
The `#` table of the connection of a load, where one stream keeps its operations until its next commit, in the order of the source: each record, and each deletion of a key (`_elt_op`). Only that connection sees it.
_Avoid_: Buffer, staging table, table variable

**Reduced stage**:
The stage of a deduplicating commit as one operation for each key hash: the result of its operations applied one at a time. It is the source of the `MERGE` of the commit.
_Avoid_: Deduplicated stage, batch

**Hidden table**:
The table `_elt_next_<hash>` that a reload commits into. When the stream ends with no failure, the load gives its rows to the raw table by difference if the shapes agree, and swaps it in with `sp_rename` if not.
_Avoid_: Shadow table, temp table

**Evolve**:
The change in place of a raw table that no longer has the shape of its stream, when the copy does not overwrite: `ALTER TABLE` adds, drops and converts columns in one commit of the load, and the rows stay.
_Avoid_: Migration, schema drift (the cause of an evolve, not the change)

**Open reload**:
A reload whose hidden table a run made and the end of no stream gave to the raw table yet. The next run continues it. For a reload of some partitions, `_warehouse._elt_reloads` keeps which ones.
_Avoid_: Pending reload, partial reload

**Dependent view**:
A view that reads a raw table, its history or its reader view, directly or through other views. SQL Server finds the tables of a view by name, so a change of the table refreshes the view with `sp_refreshview`. A view `WITH SCHEMABINDING` stops the change.
_Avoid_: Downstream object, dependency

**Swap wait**:
The time, at most 3 seconds (`SET LOCK_TIMEOUT 3000`), that a change of a stored table waits for readers to let go before it fails the copy.
_Avoid_: Timeout (a request timeout is a setting of the driver)

**Extended property**:
The `MS_Description` property of a table, view or column, which SQL Server keeps as its description. The descriptions of the source become extended properties.
_Avoid_: Comment (Postgres's word), annotation, metadata

**Commit row**:
The row that a commit inserts into `_warehouse._elt_commits` before it changes a row. Its `rowversion` is the number of the commit.
_Avoid_: Commit record, log entry

**Commit number**:
The `rowversion` of a commit row, as a `BIGINT`. Numbers only go up, and they are not dense: writes of other `rowversion` columns and commits that rolled back are gaps.
_Avoid_: Sequence value, version (a version is a row of a table or of its history)

**High-water mark**:
`MIN_ACTIVE_ROWVERSION() - 1`: each commit number at or below it is settled, committed or rolled back. A reader reads it before it begins its snapshot.
_Avoid_: Newest commit, watermark, `@@DBTS` (the last rowversion given, also one that a transaction still holds)

**Numbering**:
The commit numbers of a database, in `_warehouse`: `_elt_commits`, `_elt_loads` and `_elt_epoch`. Every `SqlServerDestination` of the database shares it.
_Avoid_: Version, log

**Epoch**:
The id that names the numbering of a database. A new database, one whose `_warehouse` was dropped, or another copy of a database, such as one restored from a backup, has a new epoch.
_Avoid_: Generation, version, database GUID

**Copy mark**:
The value that names the copy of a database that numbered its commits, which `_elt_epoch` keeps as `mark`: `recovery_fork_guid` on SQL Server, and `database_id`, `create_date` and `physical_database_name` of `sys.databases` on Azure SQL Database. A load that reads another mark starts a new epoch, because a restored copy gives numbers again that the original gave.
_Avoid_: Database id, fingerprint, version

**Position**:
`<epoch>:<number>`: the last commit of a closed load, when no other load of the database has commits before and after it. A reader at a position sees no part of a pass.
_Avoid_: Offset, cursor (eca keeps a cursor), checkpoint, LSN (the log sequence number of SQL Server)

**History**:
The table `_elt_history_<hash>` beside a raw table, which keeps each row that a commit replaced or removed, with `replaced_in`. The `OUTPUT` of the statement that replaced or removed the row writes it; a swap writes each row of the table that it replaces.
_Avoid_: Temporal table, history table of system versioning, audit log

**Widening**:
A change of the type of a column that `ALTER COLUMN` converts so that each old value maps to one value of the new type exactly, such as `BIGINT` to `DECIMAL(38, 0)` or to `NVARCHAR(MAX)`. `FLOAT` to `NVARCHAR(MAX)` is not a widening: the conversion keeps 6 digits. The history converts its column for a widening, at an evolve and at a swap, and each position stays readable.
_Avoid_: Promotion, compatible change

**Min valid**:
`min_valid` in `_warehouse._elt_epoch`: the oldest commit that a reading can read as of. Each position before it is expired.
_Avoid_: Low-water mark, `CHANGE_TRACKING_MIN_VALID_VERSION` (its model, not its name here)

**Retention**:
How long the history keeps a position readable: a `Temporal.Duration` set on the destination, 30 days unless set.
_Avoid_: TTL, `HISTORY_RETENTION_PERIOD` (a setting of a temporal table)

**Row versioning**:
`READ_COMMITTED_SNAPSHOT` and `ALLOW_SNAPSHOT_ISOLATION` of the database: readers read the last committed version of each row, and a reading reads one snapshot. The destination needs both.
_Avoid_: MVCC (the general term), `NOLOCK` (a dirty read)

**Reading**:
A read-only `SNAPSHOT` transaction, of its own connection, that sees the database as of one position: its session context holds `elt.position`, which each reader view reads.
_Avoid_: Snapshot (a reading has one, but a snapshot alone shows commits inside a pass), time travel, `FOR SYSTEM_TIME AS OF`

**Application lock**:
A lock of `sp_getapplock` on a name, owned by a session or by a transaction. Each lock of the destination is one.
_Avoid_: Advisory lock (Postgres's word), mutex (`@zukhruf/mutex` is the package that holds some of them)

**Vector column**:
A `vector(n)` column of a rule: n float32 values that a model made. The destination keeps it as `VECTOR(n)`.
_Avoid_: Embedding (the model's output before it is a column), blob

**Table statements**:
The T-SQL that `afterCreate` gives for the raw table of a computed dataset, such as a `CREATE VECTOR INDEX`. They run each time the dataset makes the table.
_Avoid_: Hook, migration, post-hook (dbt's word)
