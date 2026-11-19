# A commit number is the rowversion of its commit row

Status: accepted by Ezz (2026-11-19).

A reader needs the high-water mark: the highest commit number below which each number is settled, so that a snapshot shows each commit at or below it. Commits of many connections run side by side, so a number can still be in flight while a higher one has committed.

- elt-sqlite writes one transaction at a time, so each number that it sees is settled.
- elt-postgresql takes a number from a sequence, holds a transaction advisory lock on it, and holds a shared lock across the two steps, so that a reader does not pass a number that was taken and not yet locked. The reader finds the first number whose lock is still held in `pg_locks`.

SQL Server gives the mechanism itself. Each database has one `rowversion` counter. `MIN_ACTIVE_ROWVERSION()` "returns the lowest active rowversion value in the current database. A rowversion value is active if it is used in a transaction that has not yet been committed", and Microsoft names it for "data synchronization that use rowversion values to group sets of changes together" ([MIN_ACTIVE_ROWVERSION](https://learn.microsoft.com/sql/t-sql/functions/min-active-rowversion-transact-sql)). The SQL Server source of elt already reads each table below `MIN_ACTIVE_ROWVERSION()` (source README, the rowversion strategy).

## Decision

- `_warehouse._elt_commits` has the column `number ROWVERSION`. A commit inserts its commit row as the first write of its transaction, before it changes a row, and takes `CAST(inserted.number AS bigint)` from the `OUTPUT` of the insert. That value is the commit number: `committed_in` of the rows that it writes and `replaced_in` of the rows that it moves into the history.
- The high-water mark is `CAST(MIN_ACTIVE_ROWVERSION() AS bigint) - 1`. A reader reads it first, then begins its `SNAPSHOT` transaction, the same order as elt-postgresql.
- A transaction that changes no row deletes its commit row before it commits. Its number is a gap, as the number of a commit that rolled back is.
- The rest of the numbering is that of elt-postgresql: `_elt_loads`, `_elt_epoch`, positions, `min_valid`, retention.

## Considered Options

- **A port of elt-postgresql: a `SEQUENCE`, a transaction lock of `sp_getapplock` on each number, and a shared lock across the two steps.** It works, but the reader must find held locks in `sys.dm_tran_locks`, which needs `VIEW DATABASE STATE`, and the application lock names of that view are cut to 32 characters.
- **An `IDENTITY` column on `_elt_commits`.** A reader cannot see a number that a transaction holds and has not committed.
- **One commit at a time for the database, under one exclusive lock.** Loads of different connections then wait for each other.
- **The rowversion of the commit row, and `MIN_ACTIVE_ROWVERSION()`.** No lock and no sequence; the number and the mark come from one counter. This option was selected.

## Consequences

- A commit never waits for another commit to take its number.
- Commit numbers are large and not dense. A position stays `<epoch>:<number>`.
- The commit row must be the first `rowversion` write of its transaction. No other table of the destination has a `rowversion` column.
- A database restored from a backup keeps its counter and its `_elt_epoch`, so numbers after the restore point can repeat. A probe must show whether `recovery_fork_guid` of `sys.database_recovery_status` changes on a point-in-time restore of Azure SQL; if it does, the epoch keeps it, and a mismatch starts a new epoch.
- To probe before code: a commit at or below the mark is visible to a `SNAPSHOT` transaction that begins after the mark was read.

Sources: elt-postgresql README, "How a reader knows which numbers are done"; source-microsoft-sql-server README, rowversion strategy; `sql-server-session.ts` of sdk-microsoft-sql-server.

## Probe (2026-11-20): the high-water mark and a `SNAPSHOT` transaction

**The decision holds as written.** On both servers, a number that a transaction holds stops the mark below it, and no committed number at or below a mark was missing from the snapshot that began after the mark was read.

Servers: Azure SQL Database (datahub BILLING), `Microsoft SQL Azure (RTM) - 12.0.2000.8`, EngineEdition 5; SQL Server 2025 in Docker, `Microsoft SQL Server 2025 (RTM-CU11) (KB5129223) - 17.0.5065.9 (X64)`, EngineEdition 3. The table was `dbo.zz_elt_probe_commits (id int IDENTITY PRIMARY KEY, number rowversion NOT NULL, note nvarchar(50))`, dropped at the end.

Part A, three sessions. Session 1 holds its commit row open, session 2 commits a later one, and a reader reads the mark and then begins its snapshot (Azure SQL; Docker gave the same rows with the numbers 2003 and 2004):

```text
w1> BEGIN TRAN; INSERT INTO dbo.zz_elt_probe_commits (note) OUTPUT CAST(inserted.number AS bigint) AS number VALUES (N'w1, held open');
  {"number":"196175"}
w2> BEGIN TRAN; INSERT INTO dbo.zz_elt_probe_commits (note) OUTPUT CAST(inserted.number AS bigint) AS number VALUES (N'w2, committed'); COMMIT;
  {"number":"196176"}
r>  SELECT CAST(MIN_ACTIVE_ROWVERSION() AS bigint) AS min_active_rowversion, CAST(MIN_ACTIVE_ROWVERSION() AS bigint) - 1 AS high_water_mark, CAST(@@DBTS AS bigint) AS dbts
  {"min_active_rowversion":"196175","high_water_mark":"196174","dbts":"196176"}
r>  SET TRANSACTION ISOLATION LEVEL SNAPSHOT; BEGIN TRAN; SELECT CAST(number AS bigint) AS number, note, ... FROM dbo.zz_elt_probe_commits ORDER BY number;
  {"number":"196176","note":"w2, committed","side":"above mark"}
w1> COMMIT
r>  SELECT CAST(number AS bigint) AS number, note FROM dbo.zz_elt_probe_commits ORDER BY number; COMMIT;
  {"number":"196176","note":"w2, committed"}
r>  SELECT CAST(MIN_ACTIVE_ROWVERSION() AS bigint) - 1 AS high_water_mark_after_w1_commits
  {"high_water_mark_after_w1_commits":"196176"}
```

- `OUTPUT CAST(inserted.number AS bigint)` gives the commit number of the insert.
- The mark stays below 196175 while session 1 holds it, although 196176 committed. The snapshot shows 196176 above the mark, so the reader must skip numbers above its mark, as the decision says.

Part B, four writer sessions and one reader. Each writer transaction inserts a commit row, waits 0 to 80 ms, and commits (about 10% roll back). The reader reads the mark, then reads all numbers in a new `SNAPSHOT` transaction, again and again. At the end, each reading is compared with the committed rows:

```text
Azure SQL Database (datahub BILLING)
  writer transactions: 160 (about 10% rolled back), committed rows at the end: 147 (+2 of part A)
  readings: 27
  committed numbers at or below a reading's mark that its snapshot did not see: 0
  numbers above a reading's mark that its snapshot saw (the reader must skip them): 67
SQL Server 2025 in Docker
  writer transactions: 400 (about 10% rolled back), committed rows at the end: 343 (+2 of part A)
  readings: 1719
  committed numbers at or below a reading's mark that its snapshot did not see: 0
  numbers above a reading's mark that its snapshot saw (the reader must skip them): 1832
```

## Probe (2026-11-20): `recovery_fork_guid` after a restore

Ezz ruled on 2026-11-19 that this probe runs in Docker only. Thus it was probed on SQL Server 2025 (the box product's `RESTORE … WITH STOPAT`), not on the point-in-time restore of Azure SQL.

**On SQL Server 2025 the consequence holds**: each restore gives the database a new `recovery_fork_guid`, a restart does not, and the numbers after the restore point repeat. **On Azure SQL Database the view does not exist, which contradicts "the epoch keeps it" for Azure SQL Database: needs Ezz.**

SQL Server 2025 in Docker (17.0.5065.9). The database `zz_elt_probe_src` is in the full recovery model. Its commit table took 2001 before a full backup and 2002 after it. Then `STOPAT` was read, a row took a number after it, 20,000 updates moved the counter to 22083, and a log backup ran:

```text
SQL> SELECT ... CAST(number AS bigint) AS number, note FROM zz_elt_probe_src.dbo.zz_elt_probe_commits ORDER BY number
  {"number":"2001","note":"before the full backup"}
  {"number":"2002","note":"after the full backup"}
  {"number":"22083","note":"after STOPAT"}
SQL> RESTORE DATABASE zz_elt_probe_pit FROM DISK = N'.../zz_elt_probe_src.bak' WITH MOVE ..., NORECOVERY
SQL> RESTORE LOG zz_elt_probe_pit FROM DISK = N'.../zz_elt_probe_src.trn' WITH STOPAT = N'2026-11-19 21:31:15.046', RECOVERY
SQL> RESTORE DATABASE zz_elt_probe_full FROM DISK = N'.../zz_elt_probe_src.bak' WITH MOVE ..., RECOVERY
SQL> SELECT DB_NAME(database_id) AS db, recovery_fork_guid, first_recovery_fork_guid, database_guid, family_guid FROM sys.database_recovery_status WHERE ...
  {"db":"zz_elt_probe_full","recovery_fork_guid":"86A7BDD9-…","first_recovery_fork_guid":"3AB859B0-…","database_guid":"5EA074DE-…","family_guid":"3AB859B0-…"}
  {"db":"zz_elt_probe_pit","recovery_fork_guid":"0DA918FA-…","first_recovery_fork_guid":"3AB859B0-…","database_guid":"271CA39A-…","family_guid":"3AB859B0-…"}
  {"db":"zz_elt_probe_src","recovery_fork_guid":"3AB859B0-…","first_recovery_fork_guid":null,"database_guid":"885997B6-…","family_guid":"3AB859B0-…"}
SQL> EXEC zz_elt_probe_pit.sys.sp_executesql N'SELECT CAST(@@DBTS AS bigint) AS dbts, CAST(MIN_ACTIVE_ROWVERSION() AS bigint) - 1 AS high_water_mark'
  {"dbts":"10000","high_water_mark":"10000"}
SQL> INSERT INTO zz_elt_probe_pit.dbo.zz_elt_probe_commits (note) OUTPUT CAST(inserted.number AS bigint) AS number_after_restore VALUES (N'first write after the restore')
  {"number_after_restore":"10001"}
-- the same restore in place: RESTORE DATABASE zz_elt_probe_src ... WITH REPLACE, NORECOVERY; RESTORE LOG ... WITH STOPAT = ..., RECOVERY
  {"db":"zz_elt_probe_src","recovery_fork_guid":"9BD47ACE-…","first_recovery_fork_guid":"3AB859B0-…","database_guid":"885997B6-…","family_guid":"3AB859B0-…"}
  rows: 2001 "before the full backup", 2002 "after the full backup"
  {"number_after_restore":"10001"}
```

A restart and a kill of the server do not change the value (database `probe`):

```text
before restart:            {"recovery_fork_guid":"122845CD-…","database_guid":"97DC72EC-…"}  @@DBTS 2411
after docker restart:      {"recovery_fork_guid":"122845CD-…","database_guid":"97DC72EC-…"}  @@DBTS 10000
after docker kill + start: {"recovery_fork_guid":"122845CD-…","database_guid":"97DC72EC-…"}  @@DBTS 10000
```

- The point-in-time restore, the restore in place and the restore of the full backup alone each give a new `recovery_fork_guid`. `family_guid` stays, and `database_guid` stays on a restore in place.
- After the restore, the counter starts again from the restore point: the first number is 10001, below 22083, which the database gave before. Thus a position taken before the restore can name a different commit after it, as the consequence says.
- The counter jumps forward at a start of the server (2411 to 10000), and it never goes back. The numbers are not dense, which the decision already allows.

Azure SQL Database (datahub BILLING), read only:

```text
SQL> SELECT ... recovery_fork_guid ... FROM sys.database_recovery_status WHERE database_id = DB_ID()
  ERROR 208 (state 1): Invalid object name 'sys.database_recovery_status'.
SQL> SELECT name, type_desc FROM sys.all_objects WHERE schema_id = SCHEMA_ID('sys') AND name LIKE '%recovery%' ORDER BY name
  {"name":"dm_tran_global_recovery_transactions","type_desc":"VIEW"}
SQL> SELECT c.name AS column_name, TYPE_NAME(c.user_type_id) AS type FROM sys.all_columns c WHERE c.object_id = OBJECT_ID('sys.databases') AND (c.name LIKE '%guid%' OR c.name LIKE '%physical%' OR c.name = 'create_date')
  {"column_name":"create_date","type":"datetime"}
  {"column_name":"physical_database_name","type":"nvarchar"}
  {"column_name":"service_broker_guid","type":"uniqueidentifier"}
```

- Azure SQL Database has no `sys.database_recovery_status`, so the epoch cannot keep `recovery_fork_guid` there. `sys.databases` gives `create_date` and `physical_database_name`; this probe did not show whether a point-in-time restore of Azure SQL changes them.
