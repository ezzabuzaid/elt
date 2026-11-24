# A check that times out names what each read waited on

The reads of one check have 10 seconds. A read that still waited at 10 seconds failed with the reason of the check's signal, `The operation was aborted due to timeout`. The sync history recorded only that message for each stream of the gauge. Thus a check that timed out on Azure SQL Database did not tell whether the time went to the login through the gateway or to a query (datahub #5380).

Thus each read of a check fails at the abort with an `Error` that names its phase and its time in that phase, for example `timed out in open after 9800 ms`. Its `cause` is the reason of the signal, the `TimeoutError` of the check. The phases are:

| Phase        | What the read waits on                                  |
| ------------ | ------------------------------------------------------- |
| `open`       | The session of the watch: the connection and the login. |
| `statistics` | The query of the statistics of each table.              |
| `rowCounts`  | The query of the row count of each table.               |
| `lastWrites` | The query of the last write of each table.              |
| `version`    | The query of the Change Tracking version and `@@DBTS`.  |

`ChangeWatcher` of `@zukhruf/async` waits one turn of the event loop after the abort, and records a read that fails in that turn with its own error (ADR 0019 of `@zukhruf/async`). A read that fails later fails with the reason of the signal. The SDK's `cancellable` fails a query only when the server confirms the cancel, which is later than that turn. Thus the source does not wait for the SDK: an abort listener fails the phase at once. The work goes on. The SDK's cancel completes, and the connection is free for the next query. An open that goes on gives its session to the next check, or fails and leaves the session closed.

The time is on the clock of the pipeline, which the pipeline gives to `changeSignals` (ADR 0019 of `elt`). A phase starts when the read starts to wait on it, so a read that joins an open of another read counts its own time.

## Considered Options

- **The SDK fails at the abort.** `cancellable` must fail after the server confirms the cancel, so that the connection is free before the next statement. Other callers depend on this.
- **A new clock for the gauges.** The pipeline already gives its clock to `changeSignals`.
- **The phase without a time.** The time tells how much of the 10 seconds each phase used.
- **The source fails each phase at the abort, with the clock of the pipeline.** This option was selected.

## Consequences

- The sync history records `timed out in <phase> after <ms> ms` for each stream of a gauge that timed out.
- A stream whose group has more than one gauge records the error of the gauge that failed first.
- The `version` query takes no signal, so SQL Server completes it after the check stops waiting.
- The pool checks a connection with `SELECT 1` before it lends it, and that check has no phase of its own (elt #5434). Its time counts in the phase of the query that waits for the connection.

## Sources

- Backlog #5569, part A of datahub #5380.
- `@zukhruf/async` commit 7561248a, ADR 0019: a check records a read that fails in the turn of the abort with its own error.
- Commit 07baa3f9, backlog #5383: a check cancels its queries on the server through `cancellable`.
