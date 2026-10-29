# A sole writer fails the passes that it finds unfinished

A pass whose process stopped stays `running` in the sync history, because no outcome comes. Hosts called `failUnfinished` by hand to record such passes as failed. The pipeline now installs the history before each run and watch (elt ADR 0013), so the history can do it in its install.

Only the host knows whether a different process can still run a pass of its connections. Thus `new SQLiteSyncHistory({ soleWriter: true })` tells the history that no other process runs those passes, for example because the host is the leader of the flight of a connection. Its install records each pass that it finds `running` as `failed`, with the error "The process running this pass ended before the pass did". Airbyte also fails the unfinished jobs of a connection before it starts the next.

## Considered Options

- **The host calls `failUnfinished`.** The host must keep that order.
- **The install always fails unfinished passes.** A pass that a different process still runs would show as failed.
- **An option of the history, set by a host that knows that it is the only writer.** This option was selected.

## Consequences

- `failUnfinished` is gone.
- A history with no `soleWriter` leaves such a pass `running`.

Sources: elt 9478748e, cc8927b7.
