# A watch watches again after its watcher fails for a system reason

A failed watcher ended its connection, and it did not start again. ADR 0010 kept this as a consequence. A host that watches three Azure SQL databases polls each one every 30 seconds. On 2026-10-29, one new connection to one of the databases failed with `ESOCKET` ("socket hang up"), and a connection some seconds later succeeded. One such fault in a poll stopped the updates of that database until the host started again (#3299). Azure documents transient faults as normal events that a client must try again.

Thus a watcher that fails for a `system` reason watches again. This replaces the consequence of ADR 0010. The pipeline owns the restart, for the reason of ADR 0011: the pipeline sees the failure and its type. The delay after the n-th failure in a row is the delay of a retry of a copy, `min(10 s × 3^(n-1), 30 min)`, and the count has no limit. The schedule of Airbyte continues after a failed sync, and Debezium restarts its task after a retriable error with no limit by default. A check that the new watcher yields starts the count again, as Debezium does after a poll. A `config` failure stops the connection, as Airbyte fails a job with a config error at once. A watcher that breaks its contract stops its connection, because a new watcher would break it again.

## Considered Options

- **A failed watcher ends its connection.** One transient fault stops a connection until the host starts again. A killed task of Kafka Connect also waits for a manual restart.
- **The source tries again in `observe()`.** Each source would write its own retry, and the pipeline would not record the failures.
- **The pipeline watches again with the back-off of a copy, and the count has no limit.** This option was selected.
- **The pipeline stops the connection after five failures in a row,** as a copy stops its retries, and as Microsoft recommends a fixed number of retry attempts. An outage of more than about seven minutes would stop the connection.

## Consequences

- Each failure is a failed attempt in the sync history. While the watcher waits, `current_as_of` gets older.
- After a restart, each stream of the connection loads again, because the first check of a watcher covers each selected stream.
- A `WatchError` holds only the connections that a `config` failure or a broken contract stopped.
- A source must give the correct type to its failures. A `config` failure that a later attempt could fix stops the connection. For SQL Server, an unreachable server against a refused login is the second part of #3299.
- One test waits for the first restart, which is ten seconds. No test waits for the longer delays, because the pipeline has no clock seam.

Sources: Airbyte platform b52585e7 (`RetryManager.kt`, `ConnectionManagerWorkflowImpl.kt`); Debezium e6958e59 (`BaseSourceTask.java`, `ErrorHandler.java`); Kafka a2b91b76 (`WorkerTask.java`); Microsoft, "Troubleshoot common connection errors" (Azure SQL Database); backlog #3299.
