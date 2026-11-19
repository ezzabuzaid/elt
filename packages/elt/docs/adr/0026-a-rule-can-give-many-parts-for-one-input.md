# A rule can give many parts for one input

Status: accepted by Ezz (2026-11-19). This decision changes elt-sqlite, elt-postgresql and elt-sqlserver (#4736) too. Design on paper for `@eltjs/chunking` (backlog #4737).

A computed dataset keeps one output row for each key (ADR 0002 of elt-sqlite), and a rule gives one result for each input (`packages/elt/src/core/rule.ts`: `read()` gives one key and one input, and `compute` gives one `RuleResult` for each input). A long document needs many outputs: one chunk of its text for each part that an embedding model can take. Today a SharePoint proposal over 8,191 tokens is one row of `failed`, which each pass tries again (ADR 0007 of elt-sqlite). The same need comes for other inputs that hold many items, such as the pages of a PDF.

SQL calls this a table function: Postgres has set-returning functions, Snowflake has user-defined table functions (UDTF), and Hive has table-generating functions. The leaders that keep chunks in step with a source keep two facts: which source a chunk came from, and its order in the source. They replace all the chunks of a source when it changes:

- pgai keeps `(source primary key, chunk_seq)` in its store table. A changed source row deletes each of its embeddings, then adds the new chunks (`vectorizer.py`, `_delete_embeddings`). A failure goes to `ai.vectorizer_errors`, one row for each source row.
- LlamaIndex keeps `ref_doc_id` on each node. Its `IngestionPipeline` with `UPSERTS` deletes the nodes of a changed document and adds the new ones.
- .NET `VectorStoreWriter` keeps `documentid` on each chunk. It adds the new chunks of a document, then deletes the chunks that the document had.
- Haystack keeps `source_id` and `split_id` in the metadata of each split.

## Decision

- `@eltjs/elt` has a second kind of rule, `TableRule<Input, Output>`, beside `Rule<Input, Output>`. It has the same `key`, `output`, `batch`, `concurrency`, `read` and `identity`. Its `compute` gives a `TableRuleResult` for each input: `{ parts }`, a list of one or more parts in order, or `{ empty: true }`, `{ error }` or `{ gone: true }`, as a `RuleResult`. A list of no parts is not a type: an input with no parts is `empty`.
- A table rule has two groups of columns for its parts. `output` holds the content columns: what a part is, such as the text of a chunk and its count of tokens. `place` holds the place columns: where a part is in its input, such as the offsets of a chunk. A part gives the values of both groups in one record. LlamaIndex has the same split: a `TextNode` keeps `start_char_idx` and `end_char_idx` in fields of their own, beside its text (`llama_index/core/schema.py`).
- A `ComputedDataset` takes either kind of rule in `compute`. It routes by the type of the rule, not by a flag.
- A computed dataset with a table rule keeps two tables. `raw_<name>` has one output row for each key, with the columns that each computed dataset has: the key, `input_hash`, `rule`, `status` and `error`. Thus ADR 0002 of elt-sqlite, ADR 0004 (a rule failure stays on its output) and ADR 0007 of elt-sqlite (each pass tries an input at most once) hold for each key, as today. `raw_<name>_parts` has one row for each part: the key, `seq` (the order of the part, from 0), `part_hash`, the content columns and the place columns. It is unique on the key and `seq`. Readers query the views `<name>` and `<name>_parts`.
- `part_hash` is the SHA-256 of the content columns of the part. It does not cover `seq` or the place columns, as the `hash` of LlamaIndex's `TextNode` covers its text and its metadata, not its offsets. A dataset that reads the parts can key them by content, so a part whose content did not change keeps its key when an edit before it moves it. `DocumentText` keys a file by the SHA-256 of its bytes for the same reason.
- An output row and its parts always tell of the same input. The transaction that writes an output row writes its parts. It compares the new parts with the stored parts by key and `seq`: a part with the same row hash keeps its commit, a changed part is written (the row hash covers the place columns, so a part that only moved is written with its new place and keeps its part hash), and a stored part with a `seq` beyond the new list is deleted. The history keeps each part that a commit changes or removes. An output row that is `failed` or `empty` has no parts, and the deletion of an output row deletes its parts.
- `derived_status` counts output rows, one for each key (ADR 0025). The pending count is the inputs still to compute, not the parts.
- The two tables are one declaration. When either table differs from its declaration, the refresh makes both again (ADR 0004 of elt-sqlite).
- The constructor of `ComputedDataset` refuses a column of the rule named as the key, `seq`, `part_hash` or an engine column, and a name in both `output` and `place`. `validate` refuses a copy of the pipeline that makes `<name>_parts` or `raw_<name>_parts`. Each destination compares two names as its database does: SQLite in any ASCII case, because its names ignore ASCII case, and Postgres exactly, because a quoted name keeps its case (`key` of each destination's identifiers).

Each destination keeps the parts in its own way, as it keeps the output rows: SQLite with its history and positions, Postgres in the schema of `into`, and SQL Server unique on the hash of the key and `seq` (ADR 0004 of elt-sqlserver). The rule of what is due and the pool of rule calls are the same in each destination. They move into `@eltjs/elt` before the third destination (backlog #4649, ADR 0012 of elt-sqlserver), and the parts are written there one time, not in copies.

## Considered Options

- **A SQL view that cuts each text by characters.** SQL has no tokenizer, the SQL of each destination differs, and a cut by characters does not know the limit of the model. Ezz rejected it on 2026-11-19.
- **One table, with a row for each part and a row with no `seq` for an input that failed or gave nothing.** The `seq` and the columns of the rule are then filler in some rows, and a reader must know which rows to skip.
- **Every rule gives parts, and a rule of one output gives one part.** Each computed dataset then has a `seq` that is always 0, and the readers of `document_text` change.
- **A new kind of derived dataset in each destination.** Three classes repeat the rule identity, the rule failure, the status and the pool that a computed dataset already has.
- **The place of a part in its part hash**, as Haystack's `Document.id` hashes its meta with `split_idx_start` (`haystack/dataclasses/document.py`) and Unstructured hashes the page and the sequence number into `element_id` (`unstructured/documents/elements.py`). An edit near the start of an input gives each later part a new part hash, so a dataset that reads the parts by part hash computes each of them again.
- **`read()` gives a key for each part.** The parts come from `compute`; `read()` cannot know them before the rule runs.
- **A second kind of rule, whose parts the dataset keeps beside one output row for each key.** This option was selected.

## Consequences

- `@eltjs/chunking` can give the chunks of a text (its ADR 0001).
- A reader at a position never sees an output row with the parts of another input, because one transaction writes both.
- A text that changes at its end writes only the parts that changed. A dataset that reads the parts by `part_hash` asks its rule only for the new parts.
- The glossary of elt gets Table rule, Part, Part hash and Place column. The README of elt gets a section on a table rule, and each destination's README a section on the parts table.

Sources: #4737, #4740, #4649.
