# A check whose query waits too long for a lock gives no news

Status: accepted (2026-11-25, datahub #5380).

The queries of the statistics, the row counts and the last writes read the metadata of every table (`sys.stats` and `sys.dm_db_stats_properties`, `sys.partitions`, `sys.dm_db_index_usage_stats`). A schema lock on any table blocks them, for example the lock of an open `TRUNCATE` or `ALTER`. `READ UNCOMMITTED` does not help. The query of the database version takes no such lock.

On production's Central database of datahub, a job of another team rewrites the `CMAP_*_LIVE` tables at about one minute after each hour, and every third hour for about 13 minutes. While it holds its schema locks, the queries of a check waited until the limit of the check, 10 seconds, and each stream of the check recorded a failed attempt, `timed out in statistics after 10000 ms` (ADR 0007). In one night there were 228 such attempts. No data was lost: the first check after the lock read the gauges again and woke the streams that changed. Thus the failures were false: the database was not broken, it was busy.

## Decision

- `statistics`, `rowCounts` and `lastWrites` of the SDK take `lockTimeout`. The SDK puts `SET LOCK_TIMEOUT` before the query, and the query runs through `sp_executesql`, so SQL Server restores the value at the end of that scope, also when the query fails or is cancelled. A query that waits longer fails with `SqlServerLockTimeoutError` (error 1222).
- The watch gives a lock timeout of 2 seconds. A check has 10 seconds, and the next check, 30 seconds later, reads again. The SDK owns the option, because a limit on the lock wait of a statement is a fact of SQL Server, as the signal is. The source owns the value.
- When the query of a collector fails with `SqlServerLockTimeoutError`, the collector gives the values that its last read gave: no news. The gauges of the collector are then unchanged, so no stream fails and no stream wakes because of that query. The next check reads the query again. When the lock has ended, the check wakes each stream whose values changed.
- A collector that has not read yet has no values to give. Its first query that waits too long for a lock fails the streams of its gauges, as before, with `SqlServerLockTimeoutError`.
- Each other failure of a query still fails the streams of its gauges. A read that still waits at 10 seconds, for example because the server or the network stopped sending, still fails with `timed out in <phase> after <ms> ms` (ADR 0007).

## Considered Options

- **Accept the failures and document them.** The sync history shows a false failure for each stream of each blocked check, and an alert on failed attempts fires each hour.
- **`SET LOCK_TIMEOUT` and `SET LOCK_TIMEOUT -1` in one batch.** A probe showed that the batch continues after error 1222 and resets the value. But a cancel stops the batch before the reset, and the pooled connection then keeps the lock timeout for each later statement, also for the reads of a pass.
- **`SET LOCK_TIMEOUT` in the `sp_executesql` scope of the query.** The value cannot stay on the connection. This option was selected.
- **A longer limit of a check.** The job holds its locks for up to 13 minutes, and a check that waits that long sees no other change.
- **An unknown outcome in `ChangeWatcher` of `@zukhruf/async`.** A gauge could tell the watcher "could not look", which is different from "unchanged". This is purer, but it changes a package of zukhruf for one host, and the pipeline would do the same with both outcomes. It was not selected.

## Consequences

- A long lock, or a lock that does not end, leaves no failed check in the sync history. Datahub logs each query that SQL Server stopped as `[sql-server] A slow or failed query`, and the hourly reload still runs.
- While a lock is held on any table, a check finds no change in any table through the statistics, the row counts or the last writes, as before. The database versions still wake the Change Tracking and rowversion streams.
- `unchanged` now means also "the check could not look".
- A lock of 2 to 10 seconds, which before ended in a slow check that succeeded, now gives no news, and the next check finds its change 30 seconds later.
- A check under a lock now ends after about 2 seconds, not at its limit, so the check does not need to cancel the query on the server.

## Sources

- datahub #5380: CAUSE FOUND, PRODUCTION CONFIRMED, WHICH TABLE and PROPOSED FIX.
- A probe on SQL Server 2022 (16.0.4325.4) in a container, mssql 12.7.4: the README, Live checks of 2026-11-25.
- `node_modules/mssql/lib/tedious/request.js`: `query` calls `execSql` (`sp_executesql`), `batch` calls `execSqlBatch`.
- ADR 0007: a check that times out names what each read waited on.
