# The host limits discovery through its signal

`SqlServerSource.discover` took no signal. A server that stopped sending during discovery held it for good: the driver's request timeout is 0, and it stops at the first data. An open `TRUNCATE` or `ALTER` of any table in another session also blocks the metadata queries of discovery until it commits. A probe on 2026-11-09 stopped forwarding bytes through a TCP proxy after the login, and the queries of discovery were still pending after 330 seconds (backlog #4206). A host discovers when it starts, so a host process that hangs in discovery never starts its watch.

Thus `discover` takes `{ signal }`. When the signal aborts, each query of discovery sends SQL Server an attention, as a check of a watch does (`cancellable` of the SDK), the session closes, and `discover` fails with the reason of the signal. When the server sends nothing, the driver has 5 seconds to cancel a query, and then it closes the connection. The host sets the limit, for example `AbortSignal.any([stop, AbortSignal.timeout(ms)])`, and decides what to do next, such as try again after a back-off.

## Considered Options

- **A limit of the source on discovery.** No limit fits every database and every host. A host that stops also needs to end discovery before the limit.
- **The clock of the pipeline (ADR 0019 of `elt`), as a read takes.** Discovery runs before a pipeline exists, and a read needs the clock only to see that rows stopped. Discovery has a known end, so a deadline of the host fits it.
- **A signal of the host.** This option was selected.

## Consequences

- Discovery has no limit when the host gives no signal.
- `SqlServerDatabase.open` and `SqlServerSession.tables` of the SDK take `{ signal }`, as `statistics`, `rowCounts` and `lastWrites` do.
- The connection does not take the signal. The driver stops trying to connect after 15 seconds.
- The pool runs `SELECT 1` on a connection before it lends it (`validateConnection` of mssql), and that check does not take the signal. When the server stops sending during the check, the pool stops waiting for a connection after 30 seconds. Thus a stalled discovery can fail up to 30 seconds after its signal aborts.

## Sources

- Backlog #4206: discovery hangs for good when the server stalls.
- Commit 07baa3f9, backlog #5383: a check of a watch cancels its queries on the server through `cancellable`.
