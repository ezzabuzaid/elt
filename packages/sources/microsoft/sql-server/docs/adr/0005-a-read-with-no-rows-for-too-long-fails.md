# A read with no rows for too long fails

A read streams a whole table, so no limit on its total time fits every table. The driver's request timeout also stops at the first data. Thus a server or a network that stopped sending in the middle of a read held the pass for good: no error came, the sync history stayed at `running`, and the other tables of the connection waited. A probe on 2026-11-09 stopped forwarding bytes through a TCP proxy. After 360 seconds the pass had no error and no progress, and a stop did not end it after 60 seconds.

Thus the read checks each hour that rows still arrive. A read that got no row from one check to the next fails with `SqlServerUnavailableError`, a `system` failure, so a watch loads the table again with its back-off. The signal of the read also ends it while the driver has no row to give.

## Considered Options

- **A limit on the total time of a read.** A large table fails for its size.
- **The request timeout of the driver.** It stops at the first data, so it does not see a stall in the middle of a read.
- **A timer for each row.** A table of 400,000 rows makes 400,000 timers for a case that rarely comes.
- **One timer for each read, which looks for progress.** This option was selected.

## Precedents

Airbyte's platform fails a source that sent no message for too long: `maxSecondsBetweenMessages: 7200` in the `metadata.yaml` of `source-mssql`, read by its `HeartbeatMonitor`. Two checks of an hour give the same upper limit of two hours.

## Consequences

- A stalled read stops the other tables of its connection for up to two hours.
- The read waits on the clock of the pipeline (ADR 0019 of `elt`), so a read of the SDK takes a `SqlServerRead`.
- `SqlServerSource.discover` has no clock, so a server that stalls during discovery holds it. The host decides how long it waits for its start.
