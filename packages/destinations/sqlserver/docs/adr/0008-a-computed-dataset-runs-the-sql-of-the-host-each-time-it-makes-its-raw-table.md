# A computed dataset runs the SQL of the host each time it makes its raw table

Status: proposed, for Ezz's review (2026-11-19).

An approximate search of Azure SQL needs a vector index on the column: `CREATE VECTOR INDEX … WITH (METRIC = 'cosine', TYPE = 'DiskANN')`. The index has options that change with the engine (the version 3 index refuses the old `TOP_N`, `@zukhruf/vectors` README). A computed dataset makes its raw table again when its declaration changes (elt-sqlite ADR 0004), and an index that the host made by hand is then gone. The host also cannot make the index before the first refresh makes the table.

The leaders:

| Tool           | How the index of a derived table is made                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pgai           | The vectorizer declares `indexing => ai.indexing_diskann()` or `ai.indexing_hnsw()`, made after `min_rows` rows ([API reference](https://github.com/timescale/pgai/blob/main/docs/vectorizer/api-reference.md))      |
| dbt            | `post_hook`: "A SQL statement (or list of SQL statements) to be run … after a model … is built", with `{{ this }}` for the relation ([hooks](https://docs.getdbt.com/reference/resource-configs/pre-hook-post-hook)) |
| elt-postgresql | ADR 0006 keeps the indexes of a materialized view that a person made, across a change of the table                                                                                                                   |

## Decision

- `ComputedDataset` of this destination takes `afterCreate?: (table: string) => readonly string[]`. `table` is the quoted name of the raw table, such as `[marts].[raw_staff_passage_vectors]`. The statements run in the transaction that makes the raw table, each time the dataset makes it. A statement that fails is a dataset failure.
- The destination writes no `CREATE VECTOR INDEX` of its own. The host writes the T-SQL, with each option of the engine.

## Considered Options

- **The destination makes a vector index on each vector column.** The destination would choose a metric and options for the host, and a host that wants no index, or another option, could not say so.
- **A declared index, such as `new VectorIndex({ column, metric })`, as pgai's `indexing`.** It hides the options that the engine adds, as the version 3 index did.
- **The destination keeps each index that it finds on the table across a make.** The host still makes the first index by hand, after the first refresh.
- **The T-SQL of the host, which the dataset runs each time it makes the table, as dbt's `post_hook`.** This option was selected.

## Consequences

- A vector index exists from the first make of the table, and it stays across each make.
- An index made on an empty table starts exact, and Azure SQL builds its graph about 16 seconds after the rows come (`@zukhruf/vectors` README).
- SQL Server 2025 in Docker has no DiskANN index, so a test of `afterCreate` uses another statement, such as a nonclustered index on `status`.
- Open question: the name `afterCreate`, and whether the same option belongs on `View` (no: a view has no table to index).

Sources: backlog #4738; `@zukhruf/vectors` README, "SQL Server: what the probes found".
