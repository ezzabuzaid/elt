# Each vector index has a search function in marts

Status: accepted by Ezz (2026-11-21), backlog #5125.

`VECTOR_SEARCH` uses a DiskANN index only when its `TABLE` is a base table: Microsoft's reference says that the table "must be a base table. Views, temporary tables, both local and global, aren't supported", and that `VECTOR_SEARCH` "can't be used in the body of a view" ([VECTOR_SEARCH](https://learn.microsoft.com/en-us/sql/t-sql/functions/vector-search-transact-sql), updated 2026-10-19). Through the reader view `marts.<name>`, a `UNION ALL` of the raw table and its history, the search is an exact scan ([ADR 0013, Azure probe](./0013-a-computed-dataset-declares-its-indexes-and-the-destination-reconciles-them.md#probe-2026-11-21-vector-indexes-on-azure-sql-database)). Readers read only `marts` ([elt-postgresql ADR 0010](../../../postgresql/docs/adr/0010-readers-look-in-marts-and-elt-keeps-its-tables-in-warehouse.md)). Thus a fast search needed `SELECT` on `_warehouse.raw_<name>`, which gives a reader every internal column of elt.

The leaders give the reader a search object and permission on it, not on the table:

| Tool       | The search that a reader calls                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Supabase   | A SQL function, such as `match_documents(query_embedding, match_count)`, that the client calls through `rpc`                      |
| Databricks | The table function `vector_search(index, query, num_results)`, with `SELECT` on the index                                         |
| Snowflake  | A Cortex Search service, with `USAGE` on it                                                                                       |
| pgai       | A view that joins the embeddings to the source; it works because Postgres inlines a view, which SQL Server does not do for search |

## Decision

- For each declared vector index, the destination makes an inline table-valued function in `marts`, named after the reader view of the table with `_nearest`: `marts.<name>_nearest` for the raw table, and `marts.<name>_parts_nearest` for the parts table of a `TableRule`.
- Its signature is `(@query VECTOR(n), @k INT)`, with the dimensions of the column. It returns the key and `distance` of each of the `k` nearest rows; for a parts table, the key, `seq` and `distance`.
- Its body is `SELECT TOP (@k) WITH APPROXIMATE <keys>, r.[distance] FROM VECTOR_SEARCH(TABLE = [_warehouse].[raw_<name>] AS t, COLUMN = <column>, SIMILAR_TO = @query, METRIC = '<metric of the index>') AS r ORDER BY r.[distance]`. This is the syntax of the current index version; `TOP_N` is deprecated, and a current index refuses it (error 42274).
- `TableIndexes.reconcile` makes the function after the indexes of its table. It makes the function again with `CREATE OR ALTER` when the stored definition (`OBJECT_DEFINITION`) differs, and drops it when the table has no vector index. `CREATE OR ALTER` keeps the object and its grants.
- The function searches the rows of now. A search as of a position reads `marts.<name>` in a reading, with `VECTOR_DISTANCE`, and no index.
- The destination grants nothing. The function and the raw table have one owner, so the ownership chain lets a reader that may read the function read the rows it gives. `GRANT SELECT ON SCHEMA::marts`, which a host gives its readers, covers each function of `marts`. The `readers` of `SqlServerSyncHistory` keep `SELECT` on the numbering only.
- The constructor of `ComputedDataset` refuses, with a `TypeError`, two vector indexes on one table, because they would take one name, and a key named `distance`, because the function has a column of that name. `validate` refuses a copy whose reader name is the name of a function.

## Considered Options

- **The reader searches `_warehouse.raw_<name>` (the README before this ADR).** Fast, but each reader that searches needs `SELECT` on a table of `_warehouse`.
- **A view over `VECTOR_SEARCH`.** SQL Server refuses `VECTOR_SEARCH` in the body of a view.
- **A search through `marts.<name>`.** An exact scan of each row (ADR 0013).
- **A stored procedure.** A reader cannot join its result in the same query.
- **An inline table-valued function for each vector index, as Supabase's `match_documents`.** This option was selected: the optimizer inlines it, so the plan keeps the index, also when the caller joins a reader view (the probe below).

## Consequences

- A reader searches with `SELECT … FROM marts.<name>_nearest(@q, 10) AS n JOIN marts.<other> …` and needs nothing of `_warehouse`.
- A table has at most one vector index. A second vector column that needs a search is a gap of this decision.
- SQL Server 2025 in Docker (RTM-CU11) parses no `TOP … WITH APPROXIMATE` (error 102, with `PREVIEW_FEATURES` on or off), and it refuses the vector index of a computed dataset before the function (error 42217, ADR 0013). Thus the tests in Docker check the refusals and the drop of the function, and only Azure SQL shows the function that the destination makes.
- The optimizer of Azure SQL chooses between the index and an exact scan by cost. On a small table, and while the graph of a new index is not built, the plan through the function is an exact scan, as it is on the raw table.
- The function exists in `marts`, but the `catalog` of the sync history lists views and their columns only, so a reader that reads the catalog does not find it.

## Probe (2026-11-21): a search function on Azure SQL Database

Azure SQL Database (a scratch server in Ezz's own subscription, deleted after the probe), General Purpose serverless `GP_S_Gen5_1`, `EngineEdition` 5, `PREVIEW_FEATURES` off. The plans are the actual plans of `SET STATISTICS XML ON`.

Hand-made tables in the shape of a raw table (a `bigint` identity `_elt_row` as the clustered key):

- `CREATE FUNCTION marts.v_nearest(@query vector(3), @k int) RETURNS TABLE AS RETURN SELECT TOP (@k) WITH APPROXIMATE t.[id], r.[distance] FROM VECTOR_SEARCH(…) AS r ORDER BY r.[distance]` is accepted, with `TOP (@k)` a parameter. `sys.objects` gives `SQL_INLINE_TABLE_VALUED_FUNCTION`, `sys.parameters` gives `@query vector 3` and `@k int`, and `sys.columns` gives `id nvarchar` and `distance float`. `OBJECT_DEFINITION` of a function made with `CREATE OR ALTER` starts with `CREATE   FUNCTION`.
- On 20,000 rows of `vector(256)` with a cosine index:

  ```
  wide raw, direct      {"vectorIndexSeek":true,"ops":["Sort","Top","Nested Loops","Vector Index Seek","Clustered Index Seek"]}
  wide fn               {"vectorIndexSeek":true,"ops":["Top","Sort","Top","Nested Loops","Vector Index Seek","Clustered Index Seek"]}
  wide fn, literal k    {"vectorIndexSeek":true,"ops":["Sort","Top","Nested Loops","Vector Index Seek","Clustered Index Seek"]}
  wide fn, join view    {"vectorIndexSeek":true,"ops":["Sort","Hash Match","Top","Sort","Top","Nested Loops","Vector Index Seek","Clustered Index Seek","Clustered Index Scan"]}
  wide exact            {"vectorIndexSeek":false,"ops":["Top","Parallelism","Sort","Compute Scalar","Clustered Index Scan"]}
  ```

- On 2,000 rows of `vector(3)`, the optimizer chose an exact scan both on the raw table and through the function (`Top`, `Sort`, `Compute Scalar`, `Filter`, `Clustered Index Scan`). With `WITH (FORCE_ANN_ONLY)`, both plans had a `Vector Index Seek`. The function does not take the hint, because the hint fails a search with no index.
- 40 of the 2,000 rows had a `NULL` vector; a search for 2,000 rows gave 1,960, none of them with a `NULL` vector. `@k` of 0 gives no row, `NULL` fails with error 1060, and a query of 2 dimensions fails with error 42204.
- A function made before the index, or after a `DROP INDEX`, runs as an exact scan. A function survives a `DROP TABLE` and a `CREATE TABLE` of its table; a table made again with `vector(4)` fails the old function with error 42282 ("The query vector has 3 dimensions but the indexed VECTOR column has 4 dimensions").
- `DROP FUNCTION IF EXISTS` of a view's name fails with error 3705, and `CREATE OR ALTER FUNCTION` of it with error 2010.
- `_warehouse` and `marts` were owned by `dbo`. A user with only `GRANT SELECT ON SCHEMA::marts`, and another with only `GRANT SELECT ON OBJECT::marts.v_nearest`, each called the function under `EXECUTE AS USER`, with a `Vector Index Seek` on the wide table, and each got error 229 ("The SELECT permission was denied on the object 'raw_v', database 'probe', schema '_warehouse'") on the raw table.

A real `Pipeline` with this package, in a new database: a stream of 1,500 documents, and `Embedding` with a local stand-in model (26 dimensions, the count of each letter) into `document_vectors`, keyed by `name`, with `indexes: [{ type: 'vector', column: 'vector', metric: 'cosine' }]`:

```
vector index [{"name":"ix_elt_fce22617d3a2992d","vector_index_type":"DiskANN","distance_metric":"COSINE"}]
function [{"type_desc":"SQL_INLINE_TABLE_VALUED_FUNCTION","definition":"CREATE   FUNCTION [marts].[document_vectors_nearest](@query vector(26), @k int) RETURNS TABLE AS RETURN SELECT TOP (@k) WITH APPROXIMATE t.[name], r.[distance] FROM VECTOR_SEARCH(TABLE = [_warehouse].[raw_document_vectors] AS t, COLUMN = [vector], SIMILAR_TO = @query, METRIC = 'cosine') AS r ORDER BY r.[distance]"}]
parameters [{"name":"@query","type":"vector","vector_dimensions":26},{"name":"@k","type":"int","vector_dimensions":null}]
columns [{"name":"name","type":"nvarchar"},{"name":"distance","type":"float"}]
reader, function [{"user":"search_reader","rows":3}]
reader, raw table [{"user":"search_reader","error":229,"message":"The SELECT permission was denied on the object 'raw_document_vectors', database 'probe', schema '_warehouse'."}]
```

- Just after the run, the index was made on the empty table before the rows came, and the plan through the function was an exact scan. A few minutes later, `build_parameters` had no `State`, and the plans were:

  ```
  raw table                             {"vectorIndexSeek":true,"ops":["Sort","Top","Nested Loops","Vector Index Seek","Clustered Index Seek"]}
  function                              {"vectorIndexSeek":true,"ops":["Sort","Top","Nested Loops","Vector Index Seek","Clustered Index Seek"]}
  function joined with marts.documents  {"vectorIndexSeek":true,"ops":["Nested Loops","Sort","Top","Nested Loops","Vector Index Seek","Clustered Index Seek","Concatenation","Filter","Clustered Index Scan","Filter","Table Scan"]}
  ```

- A run with `metric: 'euclidean'` gave the model 0 texts, dropped the cosine index, made `ix_elt_7507da844d525a80` (`EUCLIDEAN`), and made the function again with `METRIC = 'euclidean'`; the reader with `SELECT` on `marts` still called it. A run with no index gave the model 0 texts and left no vector index and no function.
