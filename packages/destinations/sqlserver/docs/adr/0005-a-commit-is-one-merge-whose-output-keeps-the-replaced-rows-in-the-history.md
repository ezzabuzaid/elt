# A commit is one MERGE whose output keeps the replaced rows in the history

Status: accepted by Ezz (2026-11-19).

A commit applies the operations of its stage to its table, with the result that they would have one at a time: a staged delete removes its key, `replace` keeps the last record, and `cursor_newer` keeps the first record with the greatest cursor. Before it changes or removes a row, it keeps the row in the history with `replaced_in`. A row that comes again with the same row hash stays as it is. elt-postgresql does this with `INSERT … ON CONFLICT` behind a cursor guard, and a separate copy into the history.

The leaders on SQL Server:

| Tool                              | How it upserts                                                                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Debezium JDBC sink                | "The SQL Server dialect uses a `MERGE` statement" on the primary key ([docs](https://debezium.io/documentation/reference/stable/connectors/jdbc.html))                                                             |
| Meltano target-mssql (storebrand) | Bulk insert into a `#` table, then `MERGE INTO … USING #temp … WHEN MATCHED THEN UPDATE … WHEN NOT MATCHED THEN INSERT` ([`sinks.py`](https://github.com/storebrand/target-mssql/blob/main/target_mssql/sinks.py)) |
| dlt                               | `delete-insert` by default, "within a single atomic transaction"; `upsert` with `MERGE` or `UPDATE` ([merge loading](https://dlthub.com/docs/general-usage/merge-loading))                                         |
| Airbyte destination-mssql         | Deduped sync modes; its docs do not say how ([docs](https://docs.airbyte.com/integrations/destinations/mssql))                                                                                                     |

SQL Server's `MERGE` has an `OUTPUT` clause with `$action` and the `deleted` values, and composable DML lets one `INSERT … SELECT` read the output of a `MERGE` ([MERGE](https://learn.microsoft.com/sql/t-sql/statements/merge-transact-sql), [OUTPUT](https://learn.microsoft.com/sql/t-sql/queries/output-clause-transact-sql)).

## Decision

- The commit first reduces its stage to one operation for each `_elt_key_hash`, by the rules above.
- Then one statement: `INSERT INTO <history> SELECT … FROM (MERGE <table> USING <reduced stage> ON _elt_key_hash … WHEN MATCHED AND delete THEN DELETE WHEN MATCHED AND <cursor guard> AND t._elt_row_hash IS DISTINCT FROM s._elt_row_hash THEN UPDATE … WHEN NOT MATCHED BY TARGET AND not delete THEN INSERT … OUTPUT $action AS action, deleted.*) AS changes WHERE action IN ('UPDATE', 'DELETE')`.
- An overwrite and a reload in place use `DELETE … OUTPUT deleted.* INTO <history>` for the rows that the difference removes, and `INSERT` for the new rows, in the same transaction.
- A text cursor compares as UTF-8 bytes (`COLLATE Latin1_General_100_BIN2_UTF8`), as `COLLATE "C"` does in Postgres.

## Considered Options

- **`UPDATE`, `DELETE` and `INSERT`, each with its own `OUTPUT`, as dlt's `delete-insert`.** Three passes over the stage, and the same result.
- **`MERGE … WITH (HOLDLOCK)`.** The lock protects two writers of one table. A target has one writer (elt ADR 0008), and a checkpoint lock keeps two runs of one copy apart, so the hint protects no case.
- **One `MERGE`, whose output goes into the history in the same statement.** This option was selected.

## Consequences

- One statement changes the table and keeps the history, so they cannot disagree.
- `VECTOR` has no comparison, so the `MERGE` never compares vectors: the row hash covers them.
- Known faults of `MERGE` involve filtered indexes, indexed views and triggers on the target. A raw table has none of them. The vector index that a host adds (ADR 0008) must not break it: the vectors probe of 2026-11-18 showed `MERGE` rows in the next DiskANN search.
- To probe before code: composable DML over a `MERGE` into a table with a `VECTOR` column and a DiskANN index.

Sources: elt-postgresql `postgres-deduplicating-writer.ts` and `postgres-history.ts`; `@zukhruf/vectors` README, "SQL Server: what the probes found".
