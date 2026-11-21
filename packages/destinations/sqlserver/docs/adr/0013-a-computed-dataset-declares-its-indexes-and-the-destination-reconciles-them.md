# A computed dataset declares its indexes and the destination reconciles them

Status: accepted by Ezz (2026-11-21). Supersedes [ADR 0008](./0008-a-computed-dataset-runs-the-sql-of-the-host-each-time-it-makes-its-raw-table.md).

An approximate search of Azure SQL needs a vector index on the column: `CREATE VECTOR INDEX … WITH (METRIC = 'cosine', TYPE = 'DiskANN')`. Other reads need ordinary indexes, such as one on `committed_in`. The destination owns the physical tables of a computed dataset: it makes them again when the declaration changes (ADR 0006). Thus an index that a person makes by hand is gone after the next make. An indexed view over the reader view needs `SCHEMABINDING`, and a schema-bound view stops the make (ADR 0006).

ADR 0008 let the host give T-SQL (`afterCreate`) that ran only when the dataset made its raw table. A host that added or changed an index on a dataset that already had rows saw nothing until the declaration changed again, and the parts table of a table rule could not be indexed (backlog #5099). The probe below also shows that the container refuses `CREATE VECTOR INDEX` inside a user transaction (error 574), and `afterCreate` ran inside the transaction that made the table.

The leaders:

| Tool    | How the index of a derived table is made                                                                                                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dbt     | The `indexes` config of a model declares each index (`columns`, `unique`, `type`), and the adapter makes it on the relation that it builds ([Postgres configs](https://docs.getdbt.com/reference/resource-configs/postgres-configs#indexes)) |
| SQLMesh | `physical_properties` of a model declares the properties of its physical table, which the engine adapter applies ([model configuration](https://sqlmesh.readthedocs.io/en/stable/reference/model_configuration/))                            |
| pgai    | The vectorizer declares `indexing => ai.indexing_diskann()` or `ai.indexing_hnsw()` ([API reference](https://github.com/timescale/pgai/blob/main/docs/vectorizer/api-reference.md))                                                          |

## Decision

- `ComputedDataset` takes `indexes`, the indexes of its raw table, and, when its rule is a `TableRule`, `partIndexes`, the indexes of its parts table. Each one is a `SqlServerIndex`: `{ type: 'nonclustered', columns }` or `{ type: 'vector', column, metric }`, with the metric `cosine`, `euclidean` or `dot`. A `Rule` has no parts table, so the type refuses `partIndexes` for it.
- The constructor refuses, with a `TypeError` that names the column, an index on a column that the table does not have, a vector index on a column that is not a vector, and an index key of a type that SQL Server refuses: a `(max)` type (error 1919) or a vector (error 1978).
- The destination names each index `ix_elt_` and the first 16 hex digits of the SHA-256 of its declaration. A changed declaration is thus an index of another name.
- Each refresh, after the transaction that makes the tables and before it writes a row, reads the indexes of each table whose names start with `ix_elt_` from `sys.indexes`. It drops each one that is no longer declared, then makes each declared one that is missing. No table is made again and no row is computed again. An index of another name, such as a person's own, stays.
- Each of these statements runs outside a transaction, because SQL Server makes a vector index only there (error 574). A refresh that stops between two statements makes the rest the next time.
- A make of the tables again, after a changed declaration, drops their indexes with the old tables, and the same refresh makes the declared indexes on the new tables.
- A statement that fails, such as a vector index that the engine refuses, fails the dataset with the error of SQL Server.

## Considered Options

- **`afterCreate`, the T-SQL of the host that runs each time the dataset makes its raw table (ADR 0008).** A change of it on an existing table does nothing, it cannot reach the parts table, and the container refuses a vector index inside the transaction where it ran.
- **The text of `afterCreate` counts in the declaration, so a change of it makes the tables again.** Each change of an index drops every row and computes each again; for an `Embedding`, the model is paid again.
- **The user makes the indexes.** The destination makes its tables again and swaps them, so a person's index is lost, and an indexed view stops the swap (ADR 0006).
- **Declared indexes that the destination reconciles with `sys.indexes`, as dbt's `indexes` and SQLMesh's `physical_properties`.** This option was selected.

## Consequences

- An index declared on a dataset that has rows is made at the next refresh, and each row keeps its commit.
- A DiskANN index made on an empty table starts as an exact (KNN) index, and Azure SQL builds its graph about 16 seconds after the rows come (`@zukhruf/vectors` README, "SQL Server: what the probes found").
- An `NVARCHAR(MAX)` column, such as `status`, cannot be an index key (error 1919), so the engine columns of a dataset are not index keys; `committed_in` is.
- The declaration type lives in this package only (strike 1). It moves into elt when a second destination needs indexes.
- To check on Azure SQL in step S5 of #4736: a DiskANN index on the `bigint` `_elt_row`, made outside a transaction, then the `MERGE` of a commit on the indexed table, and `VECTOR_SEARCH` through `marts.<name>`.

Sources: backlog #5099; ADR 0008; `@zukhruf/vectors` README.

## Probe (2026-11-21): vector indexes in SQL Server 2025 in Docker

SQL Server 2025 (RTM-CU11) Express in Docker, with throwaway tables:

- Without `ALTER DATABASE SCOPED CONFIGURATION SET PREVIEW_FEATURES = ON`, `CREATE VECTOR INDEX` fails with error 343 ("Unknown object type 'VECTOR'").
- With it on, `CREATE VECTOR INDEX` inside `BEGIN TRANSACTION` fails with error 574 ("CREATE VECTOR INDEX statement cannot be used inside a user transaction").
- Outside a transaction, on a table whose clustered key is a `bigint` identity, it fails with error 42217 ("must have a clustered primary key on a single 4 byte INT column"). On a table with an `int` key it is made, `sys.indexes` shows it with `type_desc` `VECTOR`, and `sys.vector_indexes` gives `DiskANN` and the metric. `cosine`, `euclidean` and `dot` are each accepted; another metric is error 102.
- In the container, a table with a vector index refuses `INSERT`, `UPDATE`, `DELETE` and `MERGE` (error 42231). Azure SQL's index takes them (`@zukhruf/vectors` README).
- `DROP INDEX` of a vector index works inside a transaction.
- A nonclustered index key of `nvarchar(max)` or `varbinary(max)` fails with error 1919, and one of `vector(3)` with error 1978.
