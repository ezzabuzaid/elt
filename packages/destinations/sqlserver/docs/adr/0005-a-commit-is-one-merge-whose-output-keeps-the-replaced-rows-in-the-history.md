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

## Probe (2026-11-20)

**The decision holds as written.** One `INSERT … SELECT … FROM (MERGE … OUTPUT $action, deleted.*)` changed a table with a `VECTOR(1536)` column and a built DiskANN index, and put the replaced and removed rows, vectors included, into the history in the same statement. The approximate search after it showed the changes.

Servers: Azure SQL Database (datahub BILLING), `Microsoft SQL Azure (RTM) - 12.0.2000.8`, EngineEdition 5, with the index; SQL Server 2025 in Docker, `17.0.5065.9`, EngineEdition 3, without it (Ezz, 2026-11-19).

The tables, dropped at the end:

```sql
CREATE TABLE dbo.zz_elt_probe_raw (_elt_row bigint IDENTITY NOT NULL CONSTRAINT zz_elt_probe_raw_pk PRIMARY KEY CLUSTERED,
  _elt_key_hash binary(32) NOT NULL, _elt_row_hash binary(32) NOT NULL, committed_in bigint NOT NULL,
  id nvarchar(max) NOT NULL, body nvarchar(max), updated_at datetimeoffset(7), vector VECTOR(1536));
CREATE UNIQUE INDEX zz_elt_probe_raw_key ON dbo.zz_elt_probe_raw (_elt_key_hash);
CREATE TABLE dbo.zz_elt_probe_hist (... the same columns without IDENTITY ..., replaced_in bigint NOT NULL);
CREATE VECTOR INDEX zz_elt_probe_vix ON dbo.zz_elt_probe_raw (vector) WITH (METRIC = 'cosine', TYPE = 'DiskANN');
```

The index on Azure SQL, on the empty table, after 1,000 rows came, and after the `MERGE`:

```text
empty table:              "build_parameters":"{\"StartId\":\"0\", \"L\":\"48\", \"R\":\"48\", \"Version\":\"4\", \"State\":\"KNN\"}"
31 s after 1,000 rows:    no State key (graph built); the MERGE ran then
after the MERGE:          "build_parameters":"{\"StartId\":\"-2147483645\", \"L\":\"48\", \"R\":\"48\", \"Version\":\"3\"}"
```

In Docker the index fails, as the `@zukhruf/vectors` probe found:

```text
SQL> CREATE VECTOR INDEX zz_elt_probe_vix ON dbo.zz_elt_probe_raw (vector) WITH (METRIC = 'cosine', TYPE = 'DiskANN')
  ERROR 343 (state 2): Unknown object type 'VECTOR' used in a CREATE, DROP, or ALTER statement.
```

The stage `#zz_elt_probe_stage` held 12 operations: 3 changed rows with a newer cursor (keys 1, 2, 3), 1 changed row with an older cursor (key 4), 2 rows with the same row hash (keys 5, 6), 2 deletes (keys 7, 8), 3 new keys (5000, 5001, 5002) and 1 delete of a key that is not stored. The commit, on both servers:

```sql
BEGIN TRAN; DECLARE @n bigint = 2;
INSERT INTO dbo.zz_elt_probe_hist (_elt_row, _elt_key_hash, _elt_row_hash, committed_in, id, body, updated_at, vector, replaced_in)
SELECT _elt_row, _elt_key_hash, _elt_row_hash, committed_in, id, body, updated_at, vector, @n
FROM (
  MERGE dbo.zz_elt_probe_raw AS t
  USING #zz_elt_probe_stage AS s ON t._elt_key_hash = s._elt_key_hash
  WHEN MATCHED AND s.op = N'delete' THEN DELETE
  WHEN MATCHED AND (t.updated_at IS NULL OR s.updated_at >= t.updated_at) AND t._elt_row_hash IS DISTINCT FROM s._elt_row_hash THEN
    UPDATE SET _elt_row_hash = s._elt_row_hash, committed_in = @n, id = s.id, body = s.body, updated_at = s.updated_at, vector = s.vector
  WHEN NOT MATCHED BY TARGET AND s.op <> N'delete' THEN
    INSERT (_elt_key_hash, _elt_row_hash, committed_in, id, body, updated_at, vector) VALUES (s._elt_key_hash, s._elt_row_hash, @n, s.id, s.body, s.updated_at, s.vector)
  OUTPUT $action AS action, deleted.*
) AS changes
WHERE action IN (N'UPDATE', N'DELETE');
SELECT @@ROWCOUNT AS history_rows_inserted; COMMIT;
```

The result on Azure SQL (Docker gave the same rows, with 35 rows of commit 1 from 40 initial rows):

```text
  {"history_rows_inserted":5}
SQL> SELECT id, body, committed_in, replaced_in, LEFT(CAST(vector AS nvarchar(max)), 28) AS vector_start FROM dbo.zz_elt_probe_hist ...
  {"id":"1","body":"body 1","committed_in":"1","replaced_in":"2","vector_start":"[-3.2197475e-001,-4.3002784e"}
  {"id":"2","body":"body 2","committed_in":"1","replaced_in":"2","vector_start":"[-1.4397196e-001,3.2896200e-"}
  {"id":"3","body":"body 3","committed_in":"1","replaced_in":"2","vector_start":"[3.4030803e-002,-2.9907325e-"}
  {"id":"7","body":"body 7","committed_in":"1","replaced_in":"2","vector_start":"[-2.5395811e-001,1.8878582e-"}
  {"id":"8","body":"body 8","committed_in":"1","replaced_in":"2","vector_start":"[-7.5955316e-002,-4.3924943e"}
SQL> SELECT committed_in, COUNT(*) AS rows FROM dbo.zz_elt_probe_raw GROUP BY committed_in
  {"committed_in":"1","rows":995}
  {"committed_in":"2","rows":6}
SQL> SELECT id, body, committed_in, updated_at FROM dbo.zz_elt_probe_raw WHERE id IN (1..8, 5000..5002)
  {"id":"1","body":"body 1 changed","committed_in":"2",...}   (2 and 3 the same)
  {"id":"4","body":"body 4","committed_in":"1",...}           older cursor: the stored row stays
  {"id":"5","body":"body 5","committed_in":"1",...}           same row hash: no change (6 the same)
  {"id":"5000","body":"body 5000","committed_in":"2",...}     (5001 and 5002 the same)
```

The search after the commit, exact (`VECTOR_DISTANCE`) and approximate (`VECTOR_SEARCH … WITH APPROXIMATE`), on Azure SQL:

```text
-- the vector of updated row 1
  exact:       {"id":"1","distance":1.19e-7}  {"id":"762","distance":0.9084}
  approximate: {"id":"1","distance":1.19e-7}  {"id":"762","distance":0.9084}
-- the vector of deleted row 7
  exact:       {"id":"385","distance":0.9065} {"id":"896","distance":0.9220}
  approximate: {"id":"385","distance":0.9065} {"id":"896","distance":0.9220}
-- the vector of new row 5001
  exact:       {"id":"5001","distance":0}     {"id":"359","distance":0.9286}
  approximate: {"id":"5001","distance":0}     {"id":"203","distance":0.9387}
```

- Composable DML takes `deleted.*` with a `VECTOR` column, a `#` table as the source, `IS DISTINCT FROM` and the cursor guard. One statement wrote the table and the history.
- A DiskANN index accepts the `bigint IDENTITY` clustered primary key of ADR 0003.
- The approximate search found the changed row, did not find the deleted row, and found the new row. Its second row for 5001 differs from the exact search, so the search used the graph.
