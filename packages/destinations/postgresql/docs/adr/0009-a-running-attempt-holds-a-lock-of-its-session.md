# A running attempt holds a lock of its session

A pass whose process stopped stays `running` in `_warehouse.sync_attempts`, because no outcome comes. For example, a container restart kills a pass, and the row stays `running` until a person changes it (backlog #4661). elt-sqlite fails such a pass only when the host says that it is the sole writer of its connections (elt-sqlite ADR 0006), because a SQLite file cannot tell whether another process still runs the pass.

Postgres can tell. Postgres keeps the advisory locks of a session until the session ends, and a session ends when its process stops, also when the process was killed. The checkpoint store of this package already keeps the replications of a run apart with session locks.

Thus the attempt has a session of its own from `begin` until the pipeline disposes the pass. That session holds a lock on the attempt. Each `begin` first tries the lock of each `running` attempt of its connection. When the try gets a lock, no session holds it, so no outcome will come: the attempt is recorded as `failed`, with the failure type `system` and the error "The session running this pass ended before the pass did: its process stopped, or lost the database". Que and GoodJob tell a running job from an abandoned one in the same way.

## Considered Options

- **The next attempt of a connection fails every `running` attempt of the connection.** This is the rule that the commit numbering applies to an open load. But the pipeline records a failed change signal as an attempt while a pass of the same connection runs, so that pass would show as failed until its outcome came.
- **An option `soleWriter`, as in elt-sqlite.** The host must say what the database already knows.
- **A heartbeat, and a timeout after which an attempt fails.** Each pass writes while it reads, and the timeout is a guess.
- **A session that holds a lock on each running attempt.** This option was selected.

## Consequences

- `RecordedPass` is `AsyncDisposable`, and the pipeline disposes each pass when it ends (elt README, Sync history). A pass that ends with no outcome, for example because of an error that no history recorded, lets go of its lock there.
- A pass holds one more session to the database while it runs.
- An attempt stays `running` until the next attempt of its connection, as an open load stays open until the next load of its connection.
- A pass whose session lost the database while its process goes on can show as `failed` before it ends. Its outcome then replaces that record.
- The lock key is a hash of the attempt ID. Two running attempts that have the same hash share the lock. Each one then shows as running while either session lives.

Sources: #4661.
