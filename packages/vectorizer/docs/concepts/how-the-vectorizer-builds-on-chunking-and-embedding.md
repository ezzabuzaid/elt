# How the vectorizer builds on Chunking, the Embedding rule and an AI SDK embedding model

A host that searches what a pipeline loads needs passages, a vector for each passage, and a keyword index. elt makes these in three layers, and each layer uses the layer below it. The **vectorizer** of this package is the top layer: it writes the passage contract of `@zukhruf/retrieval`. Below it, the **`Embedding` rule** of [`@eltjs/embedding`](../../../embedding/README.md) gives a vector to each row, and the **`Chunking` rule** of [`@eltjs/chunking`](../../../chunking/README.md) cuts each text into chunks. At the bottom, an **AI SDK embedding model** from a provider package calls the model. This page tells what each layer does, and why the vectorizer exists when the two rules exist already. The words are in the [glossary](../../CONTEXT.md).

## The three layers

```text
Vectorizer                 @eltjs/vectorizer   writes the passage contract
  ├── Chunking rule        @eltjs/chunking     cuts the text of each source row into chunks
  └── Embedding rule       @eltjs/embedding    gives one vector to each part text
        └── AI SDK embedding model             calls the model (a provider package)
```

- **The AI SDK embedding model** is the `EmbeddingModel` type of the `ai` package. The host gives it, from a provider package such as `@ai-sdk/openai-compatible` ([Embedding README](../../../embedding/README.md)). elt has no code that calls a model server: the `Embedding` rule calls `embedMany` of the AI SDK with the model that the host gives (`packages/embedding/src/embedding.ts`).
- **The `Embedding` rule** is a rule of a computed dataset. It gives each loaded row the unit vector of the text of its `fields`. Its rule identity is `<provider>/<model id> (<n> dimensions)`, so a change of the model or of `dimensions` makes each vector again. `@eltjs/embedding` is a public package with one root export, and a host can use the rule without the vectorizer: `new ComputedDataset({ compute: new Embedding({ model, dimensions, clock, key, fields }) })` ([Embedding README](../../../embedding/README.md)).
- **The `Chunking` rule** is a table rule. It cuts the text of each loaded row into chunks that count at most `maxTokens` tokens, and the chunks of a text tile it ([Chunking ADR 0001](../../../chunking/docs/adr/0001-chunking-is-a-rule-of-its-own-package-that-runs-before-the-embedding.md), [ADR 0007](../../../chunking/docs/adr/0007-the-chunks-of-a-text-tile-it.md)). A host can also use it without the vectorizer ([Chunking README](../../../chunking/README.md)).
- **The vectorizer** is a composite dataset ([elt ADR 0034](../../../elt/docs/adr/0034-a-composite-dataset-refreshes-its-members-in-order-as-one-dataset.md)). It adds no new way to cut or to embed a text. It declares the two rules as members, next to its keyword index and its views. Each engine subpath, `/sqlite`, `/postgresql` and `/sqlserver`, makes its vectors with `new Embedding({ ...embedding, key: 'id', fields: ['text'] })`, and makes its chunks with `passageRule` of `src/passage-rules.ts`.

## Why the vectorizer exists

The retrievers of `@zukhruf/retrieval` only search. They read a passage contract that elt writes: passages with the metadata of their source rows, the vector of each passage with its model identity, and a keyword index ([zukhruf retrieval ADR 0001](https://github.com/JanuaryLabs/zukhruf/blob/main/packages/retrieval/docs/adr/0001-the-package-is-the-query-side-of-rag-and-reads-a-passage-contract-that-elt-writes.md)). Before this package, no part of elt wrote that contract. A host wrote the chunks, the vectors and the views by hand, one derived dataset at a time, and the keyword index did not exist ([ADR 0001](../adr/0001-the-vectorizer-writes-the-passage-contract-of-zukhruf-retrieval-one-subpath-per-engine.md), #5401). The first `Vectorizer`, on SQLite, came in commit `86b42be2`. The Postgres and SQL Server subpaths came in commit `f845aef6`.

The two rules make chunks and vectors, but they do not make the passage contract. The vectorizer adds what the contract needs and what no rule can know:

- **The source of a passage.** `Chunking` takes a key of one column. `PassageChunks` is a Decorator (Gamma et al., _Design Patterns_, 1994) of `Chunking`: `Chunking` cuts the text and gives the rule identity, and `PassageChunks` reads the source key, which can have several columns. A key of several columns gives the JSON array of their values as the source (`src/passage-rules.ts`, `sourceOf`).
- **The id of a passage.** The id is `<source>:<seq>`, from the source and the `seq` of the part. On SQL Server the id holds at most 450 characters, and `passageRule` takes `maxIdLength` to fail a source row whose ids are longer as a rule failure of its own (ADR 0001, amendment for SQL Server).
- **One passage for each row.** `chunking: 'none'` gives the rule `OnePart`, which gives one part, the whole text of the row, from offset 0 to its count of code points. So every chunking writes one parts table, and one SQL reads it.
- **One vector for each part text.** The view `<name>_chunk_texts` gives the text of each part by its part hash, and the `Embedding` rule keys its outputs by that hash. So a part text that many passages share is embedded once, and a chunk whose text did not change keeps its vector ([Chunking README](../../../chunking/README.md), ruling 3).
- **The model identity of a vector.** The vectors view gives the rule identity of `Embedding` as its `model` column (`v."rule" AS "model"`). The retrievers read the model identity from this column, and no other column holds it. A vector whose status is not `computed` is not in the view.
- **The metadata and the keyword index.** The passages view joins each passage to its source row for the metadata columns that the host lists, and to the keyword index, so a vector search and a keyword search give the same ids ([ADR 0002](../adr/0002-the-keyword-index-is-a-member-that-keeps-a-keywords-table-and-its-full-text-index-in-step.md)).
- **One status.** The status view `<name>_status` reads the row of each member in `derived_status`, and gives one state for the vectorizer.

## Which layer to use

- **A vector for each row, for your own SQL:** use the `Embedding` rule in a computed dataset. The vectorizer is not necessary.
- **The chunks of long texts, for your own SQL:** use the `Chunking` rule, then the `Embedding` rule over a view of the part texts ([Chunking recipe](../../../chunking/docs/recipes/cut-documents-into-chunks-and-embed-each-chunk.md)).
- **A search with the retrievers of `@zukhruf/retrieval`:** use the vectorizer. Give it the options of `@eltjs/chunking` as `chunking`, and the options of `@eltjs/embedding` without `key` and `fields` as `embedding` (`EmbeddingOptions` of `src/options.ts`). The vectorizer sets `key` and `fields` itself ([README](../../README.md)).

## Evidence

- `src/sqlite/vectorizer.ts`, `src/postgresql/vectorizer.ts`, `src/sqlserver/vectorizer.ts`: each `Vectorizer` imports `Embedding` from `@eltjs/embedding` and `passageRule` from `src/passage-rules.ts`, and gives `Embedding` the key `id` and the field `text` of the part texts view.
- `src/passage-rules.ts`: `PassageChunks` wraps a `Chunking` and takes its rule identity, `OnePart` gives one part for each row, `sourceOf` makes the source from the key, and `maxIdLength` fails a source row whose ids are too long.
- `src/options.ts`: `EmbeddingOptions` is the options of `@eltjs/embedding` without `key` and `fields`, and `ChunkingOptions` is the sizes of `@eltjs/chunking` or `'none'`.
- `packages/embedding/src/embedding.ts`: `Embedding` calls `embedMany` of the AI SDK with the `EmbeddingModel` that the host gives, and its rule identity is `<provider>/<model id> (<n> dimensions)`.
- `packages/embedding/src/embedding.test.ts`: a host uses `Embedding` in a `ComputedDataset` with no vectorizer, and another model or another number of dimensions embeds each row again.
- `packages/chunking/src/chunking.ts`: `Chunking` is a `TableRule` that takes a key of one column, and its rule identity is the package version, the tokenizer and the two sizes.
- `src/sqlite.test.ts`: "a vector search through the contract gives the passage with its id, source, seq, offsets, text and metadata, and each member keeps its own derived status" proves the passages of the contract; "a string model id and the provider model write one model identity, which a search with the provider model reads" proves that the `model` column is the rule identity of `Embedding`; "with no chunking each row is one passage whose end counts code points" proves `OnePart`; "a key of two columns gives the JSON array of their values as the source, and the metadata of that row" proves `sourceOf`; "a passage whose vector the model failed never reaches a vector search, and still reaches a keyword search" proves the filter of the vectors view.
- [ADR 0001](../adr/0001-the-vectorizer-writes-the-passage-contract-of-zukhruf-retrieval-one-subpath-per-engine.md): before this package, a host wrote the chunks, the vectors and the views by hand, and no keyword index existed (#5401).
