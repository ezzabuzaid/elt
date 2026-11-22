# A session that runs nothing for a minute runs SELECT 1

Status: accepted (2026-11-22, #5290).

A pass holds these sessions of the database from its start to its end:

| Session                                                       | What it holds                                                       | When it runs a statement                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------- |
| The pass's session of `SqlServerSyncHistory` (`begin`)        | the session lock of `sp_getapplock` on the attempt (ADR 0009)       | at `begin` and at `finish` or `fail` only |
| The session of `SqlServerLoad`                                | the `#temp` stage of each stream, and the open load in `_elt_loads` | when a batch is full, and at each commit  |
| The session of `SqlServerCheckpointStore` (`session`)         | nothing of its own                                                  | at each read and save of a checkpoint     |
| The session of `SqlServerStore` of `@zukhruf/mutex/sqlserver` | the session lock of each copy `id` (ADR 0009)                       | each 10 seconds, its heartbeat            |

A refresh of a computed dataset holds a `SqlServerLoad` too. Each call of a `DatabaseFiles` storage, a `positions()`, a `readPassStatus()` and an `install()` opens its own session and closes it when it ends.

A session that runs nothing can stay idle for the whole pass. A pass of datahub on Azure SQL Database (serverless) from a Mac stored 716 MB of files through `destination.files()` for 62 minutes: the history ran no statement after `begin`, and the load ran none while it waited for a file to be stored. At the end, `SqlServerSyncHistory.finish` failed with "The session of this connection ended", the attempt stayed `running`, and the run rejected with no copy results. A probe on the same database opened three sessions at 10:38 UTC and left them idle: the one queried after 10 minutes answered, and the one queried after 20 minutes had ended. tedious sends TCP keepalives each 30 seconds, so the end came from the gateway of Azure SQL, which Microsoft documents to close a session idle for 30 minutes, or from a proxy on the path. The lock sessions of the mutex run a statement each 10 seconds, and the lock of the copy held.

## Decision

- `SqlServerConnection` of `@eltjs/sdk-microsoft-sql-server` runs `SELECT 1` when it ran no statement for a minute, on the clock that `SqlServerDatabase.connect(clock)` takes. Only the connection knows when its last statement ended, so the heartbeat lives in it and every session of the destination has one. A minute is ten times below the shortest limit seen.
- The load waits on the clock of the pipeline. The sync history and the checkpoint store wait on real time, as no caller gives them a clock (elt ADR 0019).
- When the session of a pass ends all the same, by a `KILL`, a failover or the network, the server releases the lock of the attempt, and the next `begin` of the connection can record the attempt as `failed`. `finish` and `fail` then record the outcome on a session of their own, and it replaces that record, as in elt-postgresql, whose driver connects again (its ADR 0009). They do so when the statement failed with `SqlServerUnavailableError`, also when the rollback of its transaction failed with it. The record sets the same values again, so a record that the server committed before the session ended is safe to repeat.

## Considered Options

- **TCP keepalives.** tedious already sends them, and the session still ended.
- **Open a session for each statement of the history.** The lock of the attempt must outlive the transactions of `begin`, so one session holds it for the pass (ADR 0009).
- **A heartbeat in each owner of a session, as `SqlServerStore` has one.** Each owner would repeat it, and a new owner could forget it, as the history and the load did.
- **A heartbeat in `SqlServerConnection`.** This option was selected.
- **Fail the pass when the session of the history ends.** The copies committed what they loaded, and their outcomes are known. The lock only shows that the pass runs.

## Consequences

- Each session of the destination sends one `SELECT 1` each idle minute. A `SELECT 1` takes no lock, also inside a transaction.
- A session ends only when the server or the network ends it. The load then fails its copies with `SqlServerUnavailableError` at its next statement, and the history records the outcome.
- A pass whose history session ended can show as `failed` until its outcome replaces that record.

Sources: #5290; elt-postgresql ADR 0009; ADR 0009; `@zukhruf/mutex` `lock-stores/session`.
