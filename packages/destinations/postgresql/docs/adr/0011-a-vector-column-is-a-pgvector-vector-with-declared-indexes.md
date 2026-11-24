# A vector column is a pgvector vector with declared indexes

Status: proposed on 2026-11-24 by step E6 of the S9 plan, which Ezz approved ("Approve, start (Recommended)"). Item 6 of the main session's decisions sets the default for the extension. Backlog #5403.

Before this decision, a `vector` column of a rule was `BYTEA`: the bytes of `toSql` of `@zukhruf/vectors/sqlite`, as in elt-sqlite. Postgres could not search such a column, and it could not index it. SQL Server keeps a vector as `VECTOR(n)` with a DiskANN index and a search function (elt-sqlserver ADR 0007, 0013 and 0014). `PgvectorEmbeddingRetriever` of `@zukhruf/retrieval` (zukhruf #5399) searches a `vector(n)` column with `<=>`.

The leaders:

| Tool                             | Vector column and index                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| pgai vectorizer                  | `vector(n)`; `indexing => ai.indexing_hnsw(opclass => 'vector_cosine_ops', m, ef_construction)` or `ai.indexing_diskann()`           |
| LangChain `PGVector`             | `vector(n)`; `create_extension=True` runs `CREATE EXTENSION IF NOT EXISTS vector`                                                    |
| Haystack `PgvectorDocumentStore` | `vector(n)`; `create_extension=True` by default; `search_strategy='hnsw'` with `hnsw_index_creation_kwargs` (`m`, `ef_construction`) |
| dbt                              | The `indexes` config of a model declares each index, and the adapter makes it                                                        |

## Decision

- A `vector` column of a rule is `vector(n)`, with the dimensions of the column. The destination writes a vector with `toSql` of the npm package `pgvector`, and the tests read it with its `fromSql`. Ezz ruled on 2026-11-19 "Adopt pgvector (Recommended)" for the SQL form of Postgres (the amendment to `@zukhruf/vectors` ADR 0001). The text has each float32 value in full, so pgvector reads it back exactly.
- EAFP: the destination makes the table. When Postgres refuses it with SQLSTATE `42704` (no type `vector`) and a table of the dataset has a vector column, it runs `CREATE EXTENSION IF NOT EXISTS vector` and makes the table again. A savepoint keeps the transaction usable after the first try. It catches no other code.
- `PostgresDestination` takes `createExtension`, `true` unless set, as Haystack and LangChain take `create_extension`. When it is `false`, the dataset fails with a `PostgresSetupError` that tells what to run.
- A server with no pgvector installed refuses `CREATE EXTENSION` with SQLSTATE `0A000` (probe on `postgres:18-alpine`: `extension "vector" is not available`). The destination catches that code on that statement only, and fails the dataset with a `PostgresSetupError`.
- pgvector 0.8.7 is not a trusted extension (`pg_available_extension_versions.trusted` is false), so only a superuser creates it. A role that may not create it fails the dataset with SQLSTATE `42501`.
- Each of these failures is of failure type `config` (elt ADR 0029), so a watch does not try it again.
- `ComputedDataset` takes `indexes`, the indexes of `_warehouse.raw_<name>`. Each one is a `PostgresIndex`: `{ type: 'btree', columns }` or `{ type: 'vector', column, metric, build }`, where `build` is `hnsw({ m?, efConstruction? })`. `PostgresIndex` is `DatasetIndex<'btree', { build: Hnsw }>` of elt (see below).
- The metric gives the operator class: `cosine` is `vector_cosine_ops`, `euclidean` is `vector_l2_ops`, and `dot` is `vector_ip_ops`.
- The destination names each index `ix_elt_` and the first 16 hex digits of the SHA-256 of the part of its `CREATE INDEX` statement after the name: `ON <table> USING hnsw (...) WITH (...)`. That part holds the table and each option, so each change of the declaration is another name. An index name is unique in its schema in Postgres, but only in its table in SQL Server. Thus the name has the table in it here, and not in elt-sqlserver.
- Each refresh, in the transaction that makes the tables, drops each `ix_elt_` index of the table that is not declared, and makes each declared one that is missing, as elt-sqlserver ADR 0013 does. Postgres makes an HNSW index inside a transaction, so no statement runs outside it.

### The declaration moves into elt

elt-sqlserver ADR 0013 kept its index declaration in its own package (strike 1) and said that it "moves into elt when a second destination needs indexes". This decision is the second destination: strike 2, the trigger that ADR 0013 named. Thus `DatasetIndex<Ordinary, Build>` and `VectorMetric` are in `@eltjs/elt`:

- The same in both destinations: an ordinary index over key columns, or a vector index over one column with a metric, `cosine`, `euclidean` or `dot`.
- The differences are parameters: the name of the ordinary index in the engine (`nonclustered` in SQL Server, `btree` in Postgres), and the options of the build of a vector index (none for DiskANN in SQL Server, `build: Hnsw` in Postgres).
- `SqlServerIndex` is `DatasetIndex<'nonclustered', Record<never, never>>`. Its declarations do not change.
- The refusals, the names of the indexes and the reconcile stay in each destination. They read different catalogs (`sys.indexes`, `pg_index`) and follow different rules of the engines (error 574 in SQL Server).

## Considered Options

- **Keep `BYTEA`.** No search and no index in Postgres; the retriever of `@zukhruf/retrieval` cannot read the column.
- **The host creates the extension.** Each host writes the same statement, and a missing extension fails at the first make with an error of Postgres. Haystack, LangChain and pgai create it.
- **A second index type for Postgres only.** Two types for one concept, and the trigger of ADR 0013 says to move the type.
- **Write the `[1,2,3]` text with `JSON.stringify`, with no dependency.** It is a copy of `toSql` of pgvector, which Ezz chose for Postgres.
- **`vector(n)` written through pgvector, the extension made by default, and the declaration of elt.** This option was selected.

## Consequences

- A table with a `BYTEA` vector column, made before this change, has a declaration that differs from the new one. The next refresh makes it again, and its history keeps the old rows (ADR 0006).
- The tests of vector columns run on the image `pgvector/pgvector:pg18`. The default image of the fixture, `postgres:18-alpine`, has no pgvector.

Sources: backlog #5403; elt-sqlserver ADR 0013; `@zukhruf/vectors` ADR 0001; the S9 paper (#5401, D13).
