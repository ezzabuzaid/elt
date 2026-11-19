# A reading sets its position in the session context and reads row versions

Status: accepted by Ezz (2026-11-19).

A reader view reads its table as of a position: the rows with `committed_in <= P`, and the rows of the history with `committed_in <= P < replaced_in`. elt-postgresql gives the position to each reader view through the setting `elt.position` of the transaction, and a reading is a `REPEATABLE READ READ ONLY` transaction. Readers must also never wait for a load.

SQL Server gives both parts:

- `sp_set_session_context` sets a key of the session, and `@read_only = 1` stops a later change of it; a view reads it with `SESSION_CONTEXT(N'elt.position')` ([SESSION_CONTEXT](https://learn.microsoft.com/sql/t-sql/functions/session-context-transact-sql)).
- Row versioning: with `READ_COMMITTED_SNAPSHOT` on, a reader reads the last committed version of each row and takes no shared lock; with `ALLOW_SNAPSHOT_ISOLATION` on, a `SNAPSHOT` transaction reads one snapshot from its start. `READ_COMMITTED_SNAPSHOT` is on by default in Azure SQL Database ([SET TRANSACTION ISOLATION LEVEL](https://learn.microsoft.com/sql/t-sql/statements/set-transaction-isolation-level-transact-sql)).

## Decision

- Each reader view reads `TRY_CAST(SESSION_CONTEXT(N'elt.position') AS bigint)`. Null reads the table as it is now, and no row of the history.
- `reading(position?)` opens its own connection, reads the high-water mark (ADR 0002), begins a `SNAPSHOT` transaction, and below the newest commit that its snapshot sees, sets `elt.position` with `@read_only = 1`.
- The first load and each reading check `is_read_committed_snapshot_on` and `snapshot_isolation_state` of the database. When one is off, they fail with the failure type `config`, and the error gives the `ALTER DATABASE … SET …` statement that turns it on.

## Considered Options

- **A table-valued function for each table, with the position as its parameter.** Each query of a reader would change, and a view over a reader view could not pass the position on.
- **`CONTEXT_INFO`.** One `varbinary(128)` for the session, which any code can overwrite.
- **Readers with `NOLOCK`.** Dirty reads, which show rows of a commit that rolls back.
- **The session context, and row versioning.** This option was selected.

## Consequences

- A view of a host built on a reader view reads as of the same position, as in Postgres.
- A reader cannot move the position of its reading.
- A database that an administrator made without row versioning fails at the first load, not with readers that wait.
- To probe: the two settings of the datahub database.

Sources: elt-postgresql README, "A reading as of a position"; `sql-server-database.ts` of sdk-microsoft-sql-server, which reads `snapshot_isolation_state`.
