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

## Considered Options

- **One package for each engine.** A host then installs one package for each engine, and the parts that do not depend on the engine (the options, the rules) are copied. One package with a subpath for each engine is the shape of `@zukhruf/retrieval`.
- **The source is always JSON.** A key of one column then gives `["a"]` in place of `a`, and every host of one column pays for the case of several.
- **`chunking: 'none'` is a view expression for each engine.** It drops the chunks member, but each engine then needs its own count of code points, and SQL Server has none that is correct.
- **A new column for the model.** It would hold the same text as `rule`, and two columns could disagree.
