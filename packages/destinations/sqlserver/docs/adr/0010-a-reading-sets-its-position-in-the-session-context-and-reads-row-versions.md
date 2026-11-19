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

## Probe (2026-11-20)

**The decision holds as written.** The datahub database (BILLING) has both settings on. SQL Server 2025 in Docker has both off by default, which is the case where the first load fails with the failure type `config`. A read-only key of the session context refuses a change.

```text
Azure SQL Database (datahub BILLING), Microsoft SQL Azure (RTM) - 12.0.2000.8, EngineEdition 5
SQL> SELECT is_read_committed_snapshot_on, snapshot_isolation_state, snapshot_isolation_state_desc FROM sys.databases WHERE database_id = DB_ID()
  {"is_read_committed_snapshot_on":true,"snapshot_isolation_state":1,"snapshot_isolation_state_desc":"ON"}

SQL Server 2025 in Docker, 17.0.5065.9, EngineEdition 3, a new database
SQL> SELECT is_read_committed_snapshot_on, snapshot_isolation_state, snapshot_isolation_state_desc FROM sys.databases WHERE database_id = DB_ID()
  {"is_read_committed_snapshot_on":false,"snapshot_isolation_state":0,"snapshot_isolation_state_desc":"OFF"}

Both servers
SQL> EXEC sp_set_session_context @key = N'elt.position', @value = N'42', @read_only = 1;
     SELECT SESSION_CONTEXT(N'elt.position') AS position, TRY_CAST(SESSION_CONTEXT(N'elt.position') AS bigint) AS as_bigint;
  {"position":"42","as_bigint":"42"}
SQL> EXEC sp_set_session_context @key = N'elt.position', @value = N'43';
  ERROR 15664 (state 1): Cannot set key 'elt.position' in the session context. The key has been set as read_only for this session.
SQL> SELECT SESSION_CONTEXT(N'elt.position') AS position_after_attempt
  {"position_after_attempt":"42"}
```

- Before the `SNAPSHOT` probe of ADR 0002, the probe ran `ALTER DATABASE probe SET ALLOW_SNAPSHOT_ISOLATION ON` and `ALTER DATABASE probe SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE` in Docker. No setting of BILLING was changed.
- The key stays across the requests of one connection of `mssql`, which does not reset the session between them.
- The probe of a restore and `recovery_fork_guid` is in [ADR 0002](./0002-a-commit-number-is-the-rowversion-of-its-commit-row.md#probe-2026-11-20-recovery_fork_guid-after-a-restore), where the epoch is decided.
