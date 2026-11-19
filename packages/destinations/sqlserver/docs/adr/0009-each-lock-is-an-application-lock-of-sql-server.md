# Each lock is an application lock of SQL Server

Status: proposed, for Ezz's review (2026-11-19).

The siblings hold three kinds of lock:

- the checkpoint store holds one lock for each copy `id` for the run: `SqliteStore` of `@zukhruf/mutex/sqlite` in elt-sqlite (its ADR 0005), and session advisory locks in elt-postgresql (its ADR 0001);
- the DDL of a schema, which Postgres refuses from two sessions at once (elt-postgresql ADR 0003), takes a transaction lock;
- a running attempt holds a lock of its own session, so the next attempt finds a pass whose process stopped (elt-postgresql ADR 0009).

SQL Server has the same primitive: `sp_getapplock` takes a lock on a name, owned by a session or by a transaction, and the server releases it when the owner ends ([sp_getapplock](https://learn.microsoft.com/sql/relational-databases/system-stored-procedures/sp-getapplock-transact-sql)). `@zukhruf/mutex/sqlserver` holds such session locks (`SqlServerStore`), and datahub already serializes its SQL index with one.

## Decision

- `SqlServerCheckpointStore` holds one key of `SqlServerStore` of `@zukhruf/mutex/sqlserver` for each copy `id`, and skips a key that is busy, as `SQLiteCheckpointStore` does with `SqliteStore`. The store makes the sequence that `SqlServerStore` needs for its fencing tokens, in the schema of the store.
- The DDL of a schema takes a transaction lock of `sp_getapplock` on the schema name, as Postgres takes a transaction advisory lock.
- Each attempt of the sync history has a connection of its own that holds a session lock of `sp_getapplock` on the attempt. The next `begin` of its connection tries each lock with `@LockTimeout = 0`; a lock that it gets belongs to no session, and the attempt is recorded as `failed`, as in elt-postgresql ADR 0009.

## Considered Options

- **Raw `sp_getapplock` calls for the checkpoint store, as elt-postgresql calls advisory locks.** The package that the repo uses for such locks already does it, with tests, as elt-sqlite uses it.
- **Rows in a lock table, with a time limit.** A stopped process holds the row until the limit.
- **Application locks: `@zukhruf/mutex/sqlserver` for the copies, and transaction and session locks for the DDL and the attempts.** This option was selected.

## Consequences

- A copy that already runs fails fast with `Checkpoint <id> is in use by another run`.
- The server releases each session lock when its connection ends, also when the process was killed.
- `sp_getapplock` cuts a name at 255 characters. A copy `id` or an attempt is named by its hash.

Sources: elt-sqlite ADR 0005; elt-postgresql ADRs 0001, 0003, 0009; `@zukhruf/mutex` `lock-stores/sqlserver`.
