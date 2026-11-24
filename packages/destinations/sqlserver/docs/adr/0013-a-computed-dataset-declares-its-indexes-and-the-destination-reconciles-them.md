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
- A DiskANN index made on an empty table starts as an exact (KNN) index, and Azure SQL builds its graph after the rows come (`@zukhruf/vectors` README, "SQL Server: what the probes found"). An index on 3 rows stayed exact; after 1,200 more rows its graph was built (the Azure probe below).
- An `NVARCHAR(MAX)` column, such as `status`, cannot be an index key (error 1919), so the engine columns of a dataset are not index keys; `committed_in` is.
- The declaration type lives in this package only (strike 1). It moves into elt when a second destination needs indexes.

## Amendment (2026-11-24): the declaration moved into elt

elt-postgresql declares indexes too (its ADR 0011, backlog #5403). That is strike 2, the trigger that this ADR named. Thus the type moved into `@eltjs/elt` as `DatasetIndex<Ordinary, Build>`, with `VectorMetric`:

- The two destinations share the shape: an ordinary index over key columns, or a vector index over one column with the metric `cosine`, `euclidean` or `dot`.
- `Ordinary` is the name of the ordinary index in the engine: `nonclustered` here, `btree` in Postgres. `Build` is the options of the build of a vector index: none here, as SQL Server takes no options for DiskANN; `build: hnsw(...)` in Postgres.
- `SqlServerIndex` is now `DatasetIndex<'nonclustered', Record<never, never>>`. A declaration of this package is the same as before, and each index keeps its name.
- The refusals, the names of the indexes and the reconcile stay in this package: they read `sys.indexes` and follow the rules of SQL Server, such as error 574. In Postgres an index name is unique in its schema, so elt-postgresql hashes its statement, which holds the table, and this package does not.
- Azure SQL Database makes the DiskANN index on the `bigint` `_elt_row`, with no preview feature, and the `MERGE` of each commit and its `OUTPUT deleted.*` work on the indexed table (the Azure probe below).
- `VECTOR_SEARCH` uses the index only when its `TABLE` is the raw table and its result is not joined in the same query block. Through the reader view `marts.<name>`, a `UNION ALL` of the raw table and its history, it runs as an exact scan. Thus an approximate search reads `_warehouse.raw_<name>` as it is now, through the search function `marts.<name>_nearest` that the destination makes for the vector index ([ADR 0014](./0014-each-vector-index-has-a-search-function-in-marts.md)). A search as of a position reads `marts.<name>` in a reading, with no index.

Sources: backlog #5099; ADR 0008; `@zukhruf/vectors` README.

## Probe (2026-11-21): vector indexes in SQL Server 2025 in Docker

SQL Server 2025 (RTM-CU11) Express in Docker, with throwaway tables:

- Without `ALTER DATABASE SCOPED CONFIGURATION SET PREVIEW_FEATURES = ON`, `CREATE VECTOR INDEX` fails with error 343 ("Unknown object type 'VECTOR'").
- With it on, `CREATE VECTOR INDEX` inside `BEGIN TRANSACTION` fails with error 574 ("CREATE VECTOR INDEX statement cannot be used inside a user transaction").
- Outside a transaction, on a table whose clustered key is a `bigint` identity, it fails with error 42217 ("must have a clustered primary key on a single 4 byte INT column"). On a table with an `int` key it is made, `sys.indexes` shows it with `type_desc` `VECTOR`, and `sys.vector_indexes` gives `DiskANN` and the metric. `cosine`, `euclidean` and `dot` are each accepted; another metric is error 102.
- In the container, a table with a vector index refuses `INSERT`, `UPDATE`, `DELETE` and `MERGE` (error 42231). Azure SQL's index takes them (`@zukhruf/vectors` README).
- `DROP INDEX` of a vector index works inside a transaction.
- A nonclustered index key of `nvarchar(max)` or `varbinary(max)` fails with error 1919, and one of `vector(3)` with error 1978.

## Probe (2026-11-21): vector indexes on Azure SQL Database

Azure SQL Database (a scratch server in Ezz's own subscription), General Purpose serverless `GP_S_Gen5_1`, `EngineEdition` 5, `PREVIEW_FEATURES` off. The resource group was deleted after the probe. A real `Pipeline` loaded a stream of documents, `Chunking` cut each text into parts, a `View` gave the text of each part by its part hash, and `Embedding` with a local stand-in model (26 dimensions, the count of each letter) made the vectors of `_warehouse.raw_proposal_chunk_vectors`, with `indexes: [{ type: 'vector', column: 'vector', metric: 'cosine' }]`. No statement was written by hand except the reads below.

- The first refresh made the index, outside a transaction, on the table with its `bigint` identity key. `PREVIEW_FEATURES` stayed off:

  ```
  name                             type_desc     vector_index_type  distance_metric
  PK__raw_prop__961F1354C950A606   CLUSTERED     null               null
  key_hash                         NONCLUSTERED  null               null
  ix_elt_fce22617d3a2992d          VECTOR        DiskANN            COSINE

  clustered key: _elt_row  bigint  is_identity true
  ```

- A second run changed one document and removed another. The model got 1 text. The `MERGE` of the commit and its `OUTPUT deleted.*` worked on the indexed table: the history kept the 2 replaced or removed parts (`committed_in` 2006, `replaced_in` 2011), and 3 rows stayed. Later, with 1,202 rows and the graph built, a run that changed 50 documents and removed 20 kept 70 rows in the history (`replaced_in` 2105), and 1,182 rows stayed.
- A change of the metric to `euclidean` on the filled table dropped `ix_elt_fce22617d3a2992d` and made `ix_elt_7507da844d525a80` (`EUCLIDEAN`). The model got 0 texts, and the rows kept their commits: 3 rows, the newest `committed_in` 2012 before and after. The change back to `cosine` with 1,202 rows took 54 seconds for the whole run, the model got 0 texts, the newest `committed_in` stayed 2089, and `sys.vector_indexes` showed `ix_elt_fce22617d3a2992d` again.
- `build_parameters` of an index on 3 rows was `{"StartId":"0", "L":"48", "R":"48", "Version":"4", "State":"KNN"}`: an exact index. After 1,200 more rows it was `{"StartId":"-2147483509", "L":"48", "R":"48", "Version":"3"}`, with no `State`: the graph was built. An index made on the filled table had no `State` at once.
- `VECTOR_SEARCH` through the reader view ran, and gave the rows that the exact search gives, but its plan had no `Vector Index Seek`: `Sort`, `Compute Scalar`, `Concatenation`, `Filter`, `Clustered Index Scan`, `Table Scan`. On the raw table its plan was `Sort`, `Top`, `Nested Loops`, `Vector Index Seek`, `Clustered Index Seek`, with the index `ix_elt_7507da844d525a80`. On the raw table with 1,182 rows:

  ```
  raw, no join, no where   { vectorIndexSeek: true, rows: 3 }
  raw, where status        { vectorIndexSeek: true, rows: 3 }
  raw, join parts view     { vectorIndexSeek: false, rows: 3 }
  raw in a CTE, then join  { vectorIndexSeek: true, rows: 3 }
  ```

  Thus a search takes its nearest rows from the raw table in a common table expression, with a filter on `status` if necessary, and joins them after.

- In a reading as of the position after the first run, `VECTOR_SEARCH` through `marts.proposal_chunk_vectors` gave the vectors of that position, such as the old chunk of the changed document (`'A solar roof for the school.…'`, distance 0.7071). On the raw table, the same reading found the new vector of that chunk, whose part hash no part of the position has (a row with `null` part). The raw table holds the rows of now; a `SNAPSHOT` transaction does not stop `VECTOR_SEARCH` on it.
