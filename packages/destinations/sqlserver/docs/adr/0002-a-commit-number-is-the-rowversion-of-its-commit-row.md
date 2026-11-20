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
- A database restored from a backup keeps its `_elt_epoch`, and its counter goes back, so numbers after the restore point repeat (both probes below). The epoch keeps a mark of the database copy, and when the stored mark is not equal to the mark that the destination reads now, a new epoch starts. On SQL Server the mark is `recovery_fork_guid` of `sys.database_recovery_status`, which each restore changes and a restart does not. Azure SQL Database has no such view, so there the mark is the three values `database_id`, `create_date` and `physical_database_name` of `sys.databases`, and a change of any one of them starts a new epoch. Each restore changes all three. A rename (`create_date`) and a change of service objective (`physical_database_name`) also start a new epoch, with no restore. Such a new epoch costs readers one full read and gives no wrong row, but a restore that the mark does not see gives readers wrong rows, so the mark takes each value that a restore changes (decided 2026-11-20 after the Azure probe).
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

**On SQL Server 2025 the consequence holds**: each restore gives the database a new `recovery_fork_guid`, a restart does not, and the numbers after the restore point repeat. **On Azure SQL Database the view does not exist, so on Azure SQL Database the epoch keeps the values of `sys.databases` that the next probe found (the consequence above, decided 2026-11-20).**

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

## Probe (2026-11-20): an Azure SQL Database point-in-time restore

Ezz ruled on 2026-11-20 that this probe runs in his own subscription. Server: Azure SQL Database (a scratch server in Ezz's own subscription), region Sweden Central (West Europe and North Europe accepted no new servers), tier Basic. The scratch resource group was deleted at the end, and `az group show` then gave `ResourceGroupNotFound`.

**After a point-in-time restore, `database_id`, `create_date` and `physical_database_name` change, and the counter gives numbers again that the original database gave. After the original is dropped and the restored database takes its name, `database_id` and `physical_database_name` stay, but `create_date` changes by 8 seconds. A change of service objective (Basic to S0) also changes `physical_database_name`.**

Each candidate was read twice: as the server admin, and as `zzreader`, a contained database user with only `SELECT` and `INSERT` on the probe table. Both users read the same values from `sys.databases` and `sys.database_files`. Only `sys.dm_db_log_stats` needs `VIEW DATABASE STATE` (error 297 for `zzreader`).

```sql
CREATE TABLE dbo.zz_elt_probe_commits (id int IDENTITY PRIMARY KEY, number rowversion NOT NULL, note nvarchar(80));
SELECT CAST(@@DBTS AS bigint) AS dbts, CAST(MIN_ACTIVE_ROWVERSION() AS bigint) - 1 AS high_water_mark;
SELECT DB_ID() AS db_id, d.create_date, d.physical_database_name, d.service_broker_guid FROM sys.databases d WHERE d.database_id = DB_ID();
SELECT * FROM sys.database_service_objectives;
SELECT file_id, file_guid, type_desc, name, physical_name FROM sys.database_files;
SELECT * FROM sys.databases WHERE database_id = DB_ID();   -- compared column by column
SELECT * FROM sys.database_recovery_status WHERE database_id = DB_ID();
```

The database was made at 10:06:12 UTC. Its first backup was at 10:42:46 (`log_backup_time` of `sys.dm_db_log_stats`, and `earliestRestoreDate` of `az sql db show`). A restore to a time before that failed with `NoRestorePointAvailable`, so the restore point T is 10:45:39, after the first backup. The rows 2001 to 20682 were written before T. After T, a row took 20683, 20,000 updates moved it to 40762, and one more row took 40763. Then `az sql db restore --time 2026-11-20T10:45:39Z --dest-name zzprobe_pit` ran (1 minute 41 seconds):

```text
original at T          db_id 5  create_date 2026-11-20T10:06:12.560Z  physical_database_name 801a7c3b-…  @@DBTS 20682
original after T       db_id 5  create_date 2026-11-20T10:06:12.560Z  physical_database_name 801a7c3b-…  @@DBTS 40763
restored (zzprobe_pit) db_id 6  create_date 2026-11-20T10:48:57.563Z  physical_database_name fe7bb9fd-…  @@DBTS 22000
  service_broker_guid D795F0FE-… in both; file_guid of each file the same in both (data EB9652B2-…, log 5043DAB8-…)
  other columns of sys.databases that changed: is_broker_enabled 1 -> 0, is_temporal_history_retention_enabled 1 -> 0
  sys.database_recovery_status in both: ERROR 208 (state 1): Invalid object name 'sys.database_recovery_status'.
SQL> SELECT CAST(number AS bigint) AS number, note FROM dbo.zz_elt_probe_commits ORDER BY number   -- in zzprobe_pit
  the rows 2001 … 20682; the rows 20683, 40762 and 40763 are not there
SQL> INSERT INTO dbo.zz_elt_probe_commits (note) OUTPUT CAST(inserted.number AS bigint) AS number VALUES (N'first write after the restore')
  {"number":"22001"}
```

Then `az sql db delete -n zzprobe` and `az sql db rename -n zzprobe_pit --new-name zzprobe`, the common recovery flow, so that a reader sees the same database name again. After that, one more step: `az sql db update --service-objective S0`, which is not a restore:

```text
after the rename (zzprobe)  db_id 6  create_date 2026-11-20T10:49:05.400Z  physical_database_name fe7bb9fd-…  @@DBTS 22001, next number 22002
after Basic -> S0           db_id 6  create_date 2026-11-20T10:49:05.400Z  physical_database_name 7396fc83-…  @@DBTS 24000
a new database on the same server: db_id 7 (the id 5 of the dropped database did not come back)
```

- The restored database gives 22001, below 40763 that the original gave. The numbers 22001 to 40763 can name two different commits, as on SQL Server 2025.
- The counter of the restored database starts at 22000, above 20682, its value at T. A change of service objective moves it forward from 22002 to 24000. In this probe, the counter went back only at the restore.
- `_elt_epoch` is in the database, so the restored database keeps the value from before the restore. The destination sees the restore when that stored value is not equal to the value that it reads now.
- `physical_database_name` changes at each restore and stays at the rename. It also changes at a change of service objective: an epoch that keeps it starts a new epoch with no restore. A new epoch costs readers a full read, but it gives no wrong row.
- `create_date` changes at the restore and stays at the change of service objective, but it changed by 8 seconds at the rename. An epoch that keeps it starts one more new epoch after the rename.
- `database_id` changes at the restore and stays at the rename and at the change of service objective. It is a small number that the server gives; this probe did not show whether the server can give the id of a dropped database again.
- Of the values that this probe read, only `database_id` changed at the restore and at nothing else.

### What the decision takes from this probe

Each candidate starts a new epoch at each restore that this probe made. They differ in the new epochs that they start with no restore: `physical_database_name` at each change of service objective, `create_date` at the rename, and `database_id` at none here, but its reuse after a drop is not known. The two failures are not equal: a new epoch with no restore costs readers one full read, and a restore with no new epoch gives readers wrong rows. Thus on Azure SQL Database (EngineEdition 5) the epoch keeps all three values and starts a new epoch when any one of them changes (the consequence above), as a cache drops an entry when it is not sure that the entry is current.
