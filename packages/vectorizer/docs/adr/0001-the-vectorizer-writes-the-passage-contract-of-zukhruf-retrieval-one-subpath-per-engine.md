# The vectorizer writes the passage contract of @zukhruf/retrieval, one subpath per engine

`@zukhruf/retrieval` is the query side of RAG. It reads a passage contract and writes nothing: passages, the vector of each passage with the identity of its model, and a keyword index ([its ADR 0001](https://github.com/JanuaryLabs/zukhruf/blob/main/packages/retrieval/docs/adr/0001-the-package-is-the-query-side-of-rag-and-reads-a-passage-contract-that-elt-writes.md) and [ADR 0004](https://github.com/JanuaryLabs/zukhruf/blob/main/packages/retrieval/docs/adr/0004-a-keyword-retriever-queries-the-keyword-index-that-elt-writes.md)). elt is the writer of that contract. Before this package, a host wrote the chunks, the vectors and the views by hand, one derived dataset at a time, and the keyword index did not exist (elt #5401).

## Decision

`@eltjs/vectorizer` is a public package (Ezz, 2026-11-24, for #5401). It has one subpath for each engine: `/sqlite` now, then `/postgresql` and `/sqlserver`. Each subpath has a `Vectorizer`, a composite dataset ([elt ADR 0034](../../../elt/docs/adr/0034-a-composite-dataset-refreshes-its-members-in-order-as-one-dataset.md)) of the kinds of derived dataset that its destination has, and one new kind, the keyword index ([ADR 0002](./0002-the-keyword-index-is-a-member-that-keeps-a-keywords-table-and-its-full-text-index-in-step.md)). The package does not import `@zukhruf/retrieval`: it writes the contract, and its tests read the contract through the retrievers.

The members of a vectorizer named `docs`, in the order they refresh in:

| Member                 | Kind                             | What it holds                                                                             |
| ---------------------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| `docs_text`            | computed dataset, `DocumentText` | only with `loading: { file }`: the text of each stored file                               |
| `docs_documents`       | view                             | only with `loading: { file }`: the text of the file of each source row, by the source key |
| `docs_chunks`          | computed dataset, a table rule   | the parts of the text of each source row, keyed by its source                             |
| `docs_keywords`        | keyword index                    | the id, source, seq and text of each passage, and the full-text index `docs_passages_fts` |
| `docs_passages`        | view                             | the passages of the contract                                                              |
| `docs_chunk_texts`     | view                             | the text of each part, by its part hash                                                   |
| `docs_chunk_vectors`   | computed dataset, `Embedding`    | the vector of each part text                                                              |
| `docs_passage_vectors` | view                             | the vectors of the contract                                                               |
| `docs_status`          | view                             | the status view                                                                           |

The rules of the contract:

- **The id** of a passage is `<source>:<seq>`. `seq` is the integer after the last colon, so two passages never have one id.
- **The source** is the value of a source key of one column, or the JSON array of the values of a key of several columns, as the destination reads them back. The shape of the declared key picks the encoding, not the data. The package makes the JSON in JavaScript, never in SQL: SQLite's `json_array(1e21)` gives `1.0e+21`, and JavaScript gives `1e+21`. The passages view joins a composite source with `json_extract`, which reads the JSON and does not make it again.
- **The text, `start` and `end`** come from one row of the parts, so a window never mixes an old text with new offsets. The parts of a source row tile its text ([Chunking ADR 0007](../../../chunking/docs/adr/0007-the-chunks-of-a-text-tile-it.md)).
- **`chunking: 'none'`** gives one part for each source row, its whole text, from 0 to its count of code points, through a table rule in JavaScript. So every chunking writes one parts table, and one SQL reads it on each engine. SQL Server's `LEN` counts UTF-16 units and drops trailing spaces, so an `end` from SQL would be wrong there.
- **Metadata** is the columns that the host lists, and no others (Airbyte `metadata_fields`). A metadata column that has the name of a column of the passages, in ASCII case, is refused by the constructor with a `TypeError`.
- **The views read the raw tables** of the source and of the members (elt-sqlite `rawTable`), not their reader views.
- **The model of a vector** is the rule identity of `Embedding`, `<provider>/<model id> (<n> dimensions)`, as `rule AS model`. The retriever parses this text, so no column holds it twice. A vector whose model failed is not in the vectors view.
- **A passage exists only when the keyword index has it**: the passages view joins the keywords table for `rowid` and `id`. So a keyword search and a vector search give the same ids.
- **The contract value** is plain data in the shape of the options of the retrievers: `{ passages, vectors, index }`.

## Amendment 2026-11-25: the contract on SQL Server

`@eltjs/vectorizer/sqlserver` writes the same members into the database of an `SqlServerDestination` (S9 step E9). The rules above hold, with these forms:

- **Where.** Every relation of the contract is in `marts`, and the views read the raw tables of `_warehouse` (elt-sqlserver `rawTable`). A reader with `SELECT` on the schema `marts` searches through the ownership chain, and may not read `_warehouse` (probe P-MS2 of the #5401 paper, in the container). The contract value is `{ schema: 'marts', passages, vectors, index: { table } }`, the options of `SqlServerPassageStore`, `SqlServerEmbeddingRetriever` and `SqlServerKeywordRetriever`.
- **Binary ids and sources.** `docs_keywords.id` and `source` are `NVARCHAR(450) COLLATE Latin1_General_100_BIN2`, and the passages view casts `id` to that type, so its type is the type of the keyword table, as the retrievers compare ids in `Latin1_General_100_BIN2`. Each join of a source compares in binary too, so the sources `a` and `A` stay two source rows under a database collation that ignores case (elt-sqlserver ADR 0004).
- **The source join.** A key of one column joins `CONVERT(NVARCHAR(MAX), s.<key>)` to `p.source`; a key of several columns joins each value to `JSON_VALUE(p.source, '$[i]')`. Both sides are text in binary: the source is the text of the key value as the destination reads it back. The JSON is still made in JavaScript only.
- **The passage id holds at most 450 characters**, the most that a full-text key holds (900 bytes), as option (i) of the paper's D5, not hashed ids. The passage rule (`PassageChunks` or `OnePart`) takes `maxIdLength`: 450 on SQL Server, none on SQLite and Postgres. A source row whose last id `<source>:<seq>` has more UTF-16 units than that is a rule failure of its own input: its output row of `docs_chunks` is `failed`, and the error names the length and the limit. The other rows go on, and the keyword index never sees the long id. A failed input keeps no parts, so no path brings a longer id to the `MERGE` of the keyword index, and the member catches no truncation error (2628). The input of a rule with a limit is `{ source, text }`; without one it is the text, so the input hash of a SQLite or Postgres host does not change. A database at a compatibility level below 150 would give error 8152 in place of 2628; no path reaches either.
- **No vector index.** `indexing: { vectors: 'none' }` is the only value of the declaration: a search compares every vector with `VECTOR_DISTANCE`. The DiskANN index of SQL Server 2025 does not serve the contract yet (zukhruf #5475).
- **The parts of the vectors.** The vectors view joins the vectors to their parts by part hash. The parts table of elt-sqlserver has no index on `part_hash` (an `NVARCHAR(MAX)` column cannot be an index key, error 1919). With an exact search that reads every vector, that hash join adds no cost of another order. The index and an in-place change of the column wait for #5475 (elt #5610).

## Amendment 2026-11-25: the contract on Postgres

`@eltjs/vectorizer/postgresql` writes the same members into one Postgres database of elt-postgresql (S9 step E8). The tables are in `_warehouse`, and the views are in `marts` ([elt-postgresql ADR 0010](../../../destinations/postgresql/docs/adr/0010-readers-look-in-marts-and-elt-keeps-its-tables-in-warehouse.md)).

- **The contract is in `marts`.** `vectorizer.contract` is `{ schema: 'marts', passages, vectors, index: { column: 'keywords', configuration } }`, in the shape of the options of `PostgresPassageStore`, `PgvectorEmbeddingRetriever` and `PgvectorKeywordRetriever`. A reader that may read only `marts` searches by meaning and by words: the views read the tables with the rights of their owner.
- **The views read the raw tables** in `_warehouse`, the rows of now (D7), not the reader views. So a search uses the HNSW index of the vectors and the GIN index of the keywords. The probe of E8 shows both through the views.
- **The passages view** gives `id`, `source`, `seq`, `start`, `end`, `text`, `keywords` and the metadata columns. `keywords` is the `tsvector` of the keyword index ([ADR 0002](./0002-the-keyword-index-is-a-member-that-keeps-a-keywords-table-and-its-full-text-index-in-step.md)). `@zukhruf/retrieval` leaves a `tsvector` column out of the metadata. A metadata column cannot have the name `keywords`.
- **The source join compares in the type of the key.** The source of a passage is text, and a key column can be of another type, for example `bigint`. The view reads the text into the row type of the source with `jsonb_populate_record`, so the join compares in the type of the key column and finds the source row by its key index. A cast of the key column to text would read every source row.
- **The source of a composite key** is the JSON array of the values as the driver reads them back. postgres.js reads a `bigint` as text, so the key `['site', 'id']` gives `["s1","7"]`. A key of one integer column gives `7`.
- **The id of the vectors view** is `(source || ':' || seq) COLLATE "C"`, the collation of the primary key of the keywords table. So the join of the retriever from a vector to its passage finds the passage by that key.
- **A vector finds its parts by part hash.** The parts table of elt-postgresql has an index on `part_hash` (its README, "The parts table"), so each vector that HNSW gives finds its parts by an index, not by a scan of the parts. The probe of E8 on 20,000 parts: one query 12.9 ms with a scan of the parts, 0.5 ms with the index; a batch of 3 queries 25.3 ms and 1.4 ms.
- **The vector index** is `indexing: { vectors }`: `hnsw({ m?, efConstruction? })`, an HNSW index with `vector_cosine_ops`, when absent (pgai `ai.indexing_hnsw`), or `'none'`, an exact search (pgai `ai.indexing_none`). elt-postgresql makes and reconciles the index ([its ADR 0011](../../../destinations/postgresql/docs/adr/0011-a-vector-column-is-a-pgvector-vector-with-declared-indexes.md)).
- **A search for the model of few vectors** gives its `topK` while another model embeds again in place. HNSW gives its nearest vectors before the filter on the model. `PgvectorEmbeddingRetriever` sets `hnsw.iterative_scan` to `strict_order` for its query, so the scan goes on until `topK` rows pass the filter (`@zukhruf/retrieval` ADR 0003).
- **The status view** reads `_warehouse.derived_status`, where a member is named by the relation that it makes: `marts.<name>` for a view and a computed dataset, and `_warehouse.raw_docs_keywords` for the keyword index of `docs`.

## Considered Options

- **One package for each engine.** A host then installs one package for each engine, and the parts that do not depend on the engine (the options, the rules) are copied. One package with a subpath for each engine is the shape of `@zukhruf/retrieval`.
- **The source is always JSON.** A key of one column then gives `["a"]` in place of `a`, and every host of one column pays for the case of several.
- **`chunking: 'none'` is a view expression for each engine.** It drops the chunks member, but each engine then needs its own count of code points, and SQL Server has none that is correct.
- **A new column for the model.** It would hold the same text as `rule`, and two columns could disagree.
