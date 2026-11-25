# elt-postgresql drops in where elt-sqlite was

Status: Accepted 2026-11-25.

Decision-makers: Ezz, the owner, on the split of whether elt-postgresql must give each elt-sqlite API that a consumer imports a counterpart of the same shape. On 2026-11-25, Ezz picked "Write ADR 0012" for the question "It would record your 2026-11-18 ruling, found in memory: \"just make sure postgres is ready as drop in replacement for sqlite\". Commit 9c38c5d2 applied it: each elt-sqlite API a consumer imports gets a Postgres counterpart of the same shape." (session transcript `448389f7-f08c-439a-aa8a-13621b0ddccd.jsonl`, line 1136). The 2026-11-18 wording is the record of the ruling in the agent memory `postgres-production-batch`, not a prompt record; Ezz confirmed it with this pick.

elt-postgresql is the destination of `apps/google` and `apps/proactive`. elt-sqlite is the destination of other consumers, such as context-compiler. Thus the question was: when a consumer of elt-sqlite changes its destination to elt-postgresql, does it find the same APIs?

[ADR 0008](./0008-derived-datasets-follow-elt-sqlite.md) answers this question for derived datasets only: `View` and `ComputedDataset` take the declarations of elt-sqlite. Commit 9c38c5d2 looked at the other APIs that consumers imported from elt-sqlite on 2026-11-18 (the semantic layer of datahub, and context-compiler). Two had no Postgres counterpart:

- `readPassStatus(path)`, which gives the latest pass of a SQLite file and the latest outcome of each stream. On that date, the MCP readiness check of datahub called it.
- The column builders `SQLiteColumns.int64(field)` and `localTimestamp(field, precision)`, which the SQL Server connections of datahub declared on that date.

Datahub did not move to Postgres: its warehouse now imports `@eltjs/elt-sqlserver` (datahub `packages/semantic-layer/warehouse/src/warehouse.ts`, lines 4-8). This decision does not rest on datahub.

## Decision

Each elt-sqlite API that a consumer imports has a Postgres counterpart with the same shape. A difference stays only when the Postgres driver forces it.

- `readPassStatus(url)` gives the same `PassStatus`, `PassState` and `StreamPassStatus` types as `readPassStatus(path)` of elt-sqlite. It reads `marts.sync_status` and `marts.stream_status` in one `REPEATABLE READ` snapshot, and gives each time as ISO text, as SQLite stores it. A database with no sync history gives no pass and no streams. A reader role can call it with its own URL.
- `PostgresColumns.int64(field)` is a `BIGINT` that loads decimal text exactly. `PostgresColumns.localTimestamp(field, precision)` is a `TIMESTAMP` for the `datetime2` of SQL Server, and a precision past 6 loads as text that orders as time. An inferred column of the same format loads in the same way.
- The differences that the driver forces stay. The `postgres` driver reads asynchronously, so `readPassStatus` returns a `Promise`. A database has a URL, not a path. A `PostgresReading` gives `sql` as a `postgres.Sql`, where a `SQLiteReading` gives a `DatabaseSync`.

## Considered Options

- **Postgres counterparts only for what one named consumer needs.** Each other consumer of elt-sqlite, such as context-compiler, would then find a gap when it changes its destination.
- **Postgres APIs with their own shapes.** A consumer would write its reads and its column declarations again for each destination. ADR 0008 refused the same option for derived datasets.
- **Identical signatures, synchronous reads included.** The `postgres` driver has no synchronous read, so this option cannot be built.

## Consequences

- A consumer changes its destination package and its connection (a URL for a path), and awaits the reads. It keeps its types and its column declarations.
- `readPassStatus` and the two column builders were second copies of `sqlite-passes.ts` and `sqlite-columns.ts`, recorded in the ledger [copied-from-elt-sqlite.md](../copied-from-elt-sqlite.md). Later, the pass status types and `combinedPass` moved into `@eltjs/elt` (backlog #4669, commit 7c687004), and `recordedPassStatus` and `recordedStreamStatus` followed when elt-sqlserver made a third place (backlog #4736, commit 50fe53c5). Each destination keeps only its own reads. The column builders stay two copies.
- A new public API of elt-sqlite that a consumer imports needs its Postgres counterpart, unless the driver forbids it.

## Confirmation

- Commit 9c38c5d2 added `readPassStatus`, `PostgresColumns.int64` and `PostgresColumns.localTimestamp`, and released them in `@eltjs/*` 0.4.0.
- [pass-status.test.ts](../../src/pass-status.test.ts) runs a real `Pipeline` over a real Postgres. A database that no history recorded reads no pass and no streams. A running pass reads as `running`. Two connections read as one `partial` pass with the error of the failed stream, and a later pass that loads the stream clears the error. `int64` and `localTimestamp` columns load exactly, with the types `bigint`, `timestamp` and `text`.
- Live (commit 9c38c5d2): `readPassStatus` with the URL of the `agent_reader` role read the infra warehouse, which `proactive:start` and `google:start` loaded, over 97 streams.
