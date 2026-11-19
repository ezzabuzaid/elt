# A commit number is the rowversion of its commit row

Status: proposed, for Ezz's review (2026-11-19).

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
