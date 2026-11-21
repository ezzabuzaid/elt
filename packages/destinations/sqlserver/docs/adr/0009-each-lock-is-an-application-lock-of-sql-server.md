# Each lock is an application lock of SQL Server

Status: accepted by Ezz (2026-11-19).

The siblings hold three kinds of lock:

- the checkpoint store holds one lock for each copy `id` for the run: `SqliteStore` of `@zukhruf/mutex/sqlite` in elt-sqlite (its ADR 0005), and session advisory locks in elt-postgresql (its ADR 0001);
- the DDL of a schema, which Postgres refuses from two sessions at once (elt-postgresql ADR 0003), takes a transaction lock;
- a running attempt holds a lock of its own session, so the next attempt finds a pass whose process stopped (elt-postgresql ADR 0009).

SQL Server has the same primitive: `sp_getapplock` takes a lock on a name, owned by a session or by a transaction, and the server releases it when the owner ends ([sp_getapplock](https://learn.microsoft.com/sql/relational-databases/system-stored-procedures/sp-getapplock-transact-sql)). `@zukhruf/mutex/sqlserver` holds such session locks (`SqlServerStore`), and datahub already serializes its SQL index with one.

SQL Server needs one more. The open of a load inserts its row into `_warehouse._elt_loads`, then closes each open load of its owner with an `UPDATE`. The owner is `nvarchar(max)`, which cannot be an index key, so the `UPDATE` reads each row of the table with an update lock. Row versions do not apply to the rows that an `UPDATE` reads to find its targets. Postgres finds the rows through the partial index `_elt_loads_open`, and its `UPDATE` skips a row that another transaction inserted and did not commit. On SQL Server, two connections of one pipeline that open their loads at the same time each held the row it inserted and waited for the row of the other, and SQL Server stopped one with error 1205 (the deadlock graph of CI run 44904072959, 2026-11-21).

The retention also deadlocked. A commit applies it in its own transaction, after it inserts its commit row: it moves `min_valid` with an `UPDATE` of the one row of `_warehouse._elt_epoch`, deletes the commits before `min_valid`, and deletes each closed load that has no commit left. Two tests of `src/index.test.ts` hold a lock so that the statements meet, with a retention of 0, and each got error 1205 on SQL Server 2025 in Docker (2026-11-21):

- Two commits that apply the retention at once. The first holds the row of `_elt_epoch`. Its `DELETE ... WHERE CAST([number] AS bigint) < @expired` cannot seek, so it reads each key of `_elt_commits_load` with an update lock and waits for the uncommitted commit row of the second commit. The second waits for the row of `_elt_epoch`.
- A commit that applies the retention while a load opens. The `DELETE` of `_elt_loads` reads each row with an update lock, deletes the row of a closed load, and waits for the uncommitted row that the open inserted. The `UPDATE` of the open waits for the deleted row.

## Decision

- `SqlServerCheckpointStore` holds one key of `SqlServerStore` of `@zukhruf/mutex/sqlserver` for each copy `id`, and skips a key that is busy, as `SQLiteCheckpointStore` does with `SqliteStore`. The store makes the sequence that `SqlServerStore` needs for its fencing tokens, in the schema of the store.
- The DDL of a schema takes a transaction lock of `sp_getapplock` on the schema name, as Postgres takes a transaction advisory lock.
- The open of a load takes a transaction lock of `sp_getapplock` on `_warehouse._elt_loads` before it inserts its row. Thus two opens run one at a time, and an open that waits holds no row of the table.
- The retention deletes the commits before `min_valid` by a range of the rowversion, `[number] < CAST(CAST(@expired AS bigint) AS binary(8))`, which seeks the primary key. Thus it reads no commit row after `min_valid`, such as the commit row of another commit that runs.
- The retention deletes the closed loads that have no commit `WITH (READPAST)`, so it skips each row that another transaction holds: a load that opens, a load that a close changes, or a load that another retention deletes. The retention of a later commit deletes a closed load that it skipped.
- Each attempt of the sync history has a connection of its own that holds a session lock of `sp_getapplock` on the attempt. The next `begin` of its connection tries each lock with `@LockTimeout = 0`; a lock that it gets belongs to no session, and the attempt is recorded as `failed`, as in elt-postgresql ADR 0009.

## Considered Options

- **Raw `sp_getapplock` calls for the checkpoint store, as elt-postgresql calls advisory locks.** The package that the repo uses for such locks already does it, with tests, as elt-sqlite uses it.
- **Rows in a lock table, with a time limit.** A stopped process holds the row until the limit.
- **Application locks: `@zukhruf/mutex/sqlserver` for the copies, and transaction and session locks for the DDL, the open of a load and the attempts.** This option was selected.

For the open of a load:

- **An index on a hash of the owner, as ADR 0004 indexes a key.** The `UPDATE` then reads only the rows of its owner, but only if the plan seeks. On a table of a few rows the optimizer can scan, so the deadlock comes back unless a hint forces the plan.
- **`READPAST` on the `UPDATE`.** It skips each row that another transaction holds, also the uncommitted row of another open, so no open waits. It also skips the uncommitted row of a second pass of the same connection that opens at the same time, so neither pass closes the load of the other, and both can commit.
- **Retry error 1205.** The cycle stays, and each victim rolls back its work. Microsoft gives a retry of error 1205 as the last step, after the steps that remove the cycle, such as one order of access.

For the retention:

- **The lock of `_warehouse._elt_loads` in the retention, as the open takes it.** It gives one order with the open, but the open then waits until each commit that applies the retention ends, and a clear inserts its load in its own transaction before its retention, with no such lock, so a retention still waits for that row. It does not stop the deadlock of two commits: each one holds its commit row before it takes any lock.
- **`READPAST` on the `DELETE` of `_elt_commits` too.** The seek reads only commits before `min_valid`, so the cycle with the commit row of another commit is gone with no hint.

## Consequences

- A copy that already runs fails fast with `Checkpoint <id> is in use by another run`.
- The server releases each session lock when its connection ends, also when the process was killed.
- The opens of the loads of one database take turns. Each open is one short transaction.
- A retention waits for no load row that another transaction holds. A closed load that it skipped stays in `_elt_loads` until a later retention.
- `sp_getapplock` cuts a name at 255 characters. A copy `id` or an attempt is named by its hash.

Sources: elt-sqlite ADR 0005; elt-postgresql ADRs 0001, 0003, 0009; `@zukhruf/mutex` `lock-stores/sqlserver`.
