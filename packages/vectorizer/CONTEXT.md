# Vectorizer

A host wants to search what a pipeline loads, by meaning and by words, with the retrievers of `@zukhruf/retrieval`. Those retrievers read a passage contract: passages, the vector of each passage, and a keyword index. `Vectorizer` is one declaration that writes that contract from a table or a view and keeps it in step with each commit. The words that all of elt uses, for example derived dataset, composite dataset, member, rule, part and refresh, are in the glossary of [elt](../elt/CONTEXT.md). The words of a chunk and a tokenizer are in the glossary of [Chunking](../chunking/CONTEXT.md).

## Language

**Vectorizer**:
A composite dataset that writes the passage contract of `@zukhruf/retrieval` for the rows of one table or view, as pgai's `create_vectorizer` does in Postgres. Its name starts the name of each of its relations.
_Avoid_: Indexer, ingestion pipeline (LlamaIndex's word for the object that runs the steps), embedder (it makes more than vectors)

**Source row**:
One row of the table or view that the vectorizer reads. Each passage comes from one source row.
_Avoid_: Document (a document is a file), record (a record is what a source emits)

**Source key**:
The column, or the columns, that identify a source row. The source of a passage is the value of a key of one column, or the JSON array of the values of a key of several columns, for example `["s1",7]`.
_Avoid_: Id (the id names a passage), primary key (the key of the source row can be any unique columns)

**Loading**:
What text of a source row the passages cut: the text of its columns, joined with line breaks, or the text of the stored file that one column names.
_Avoid_: Fields (the fields of a stream), content

**Passage**:
One part of the text of a source row, with its source, its `seq`, its offsets `start` and `end` in code points, its text and the metadata of its source row. Its id is `<source>:<seq>`. The passages of a source row tile its text.
_Avoid_: Chunk (a chunk is what `Chunking` gives; with `chunking: 'none'` a passage is the whole text), node, document

**Metadata**:
The columns of the source row that each passage gives beside its text, as the host lists them. A metadata column cannot have the name of a column of the passages.
_Avoid_: Attributes, extra fields

**Model identity**:
The text `<provider>/<model id> (<n> dimensions)`, for example `openai/text-embedding-3-small (1536 dimensions)`, that each passage vector carries in its column `model`. It is the rule identity (elt) of `Embedding`, so a change of model embeds the vectors again in place. A vector search reads only the vectors of its own model identity (`src/sqlite.test.ts`).
_Avoid_: Model name (the model identity also has the provider and the dimensions), model version

**Keyword index**:
The member that keeps a table of the id, source, seq and text of each passage, and a full-text index over the text, which a keyword search reads. On SQLite it is an FTS5 table whose content is that table. On SQL Server it is a full-text index on that table, which is a base table in `marts`. On Postgres it is a `tsvector` column of that table, which Postgres generates from the text, with a GIN index.
_Avoid_: Search index, BM25 index (BM25 is how a search ranks), inverted index

**Contract**:
The value that tells the retrievers of `@zukhruf/retrieval` which relations to read, in the shape of their options. On SQLite it is `{ passages, vectors, index }`, three names. On Postgres and SQL Server it also has `schema`, which is `marts`, and `index` is an object: `{ column, configuration }` on Postgres (`PostgresContract`), `{ table }` on SQL Server (`SqlServerContract`).
_Avoid_: Schema, config

**Status view**:
The view `<name>_status`: one row that tells how far the relations of the vectorizer are in step with their source rows, from the rows of its members in `derived_status`.
_Avoid_: Health, progress
