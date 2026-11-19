# Each chunk gives its offsets and its count of tokens

Status: accepted by Ezz (2026-11-19). This decision changes `@eltjs/elt` and each destination too.

A reader that cites a chunk, or highlights it in its document, must know where the chunk is in the text. A host that checks its sizes must know how many tokens each chunk counts. `RuleColumn` of elt has two types, `text` and `blob` (`packages/elt/src/core/rule.ts`), so a rule cannot give a number.

The leaders give the offsets of each chunk:

| Leader                      | Offsets                                                            | In the key of the chunk                                                               |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| LlamaIndex `TextNode`       | `start_char_idx`, `end_char_idx`, fields of their own              | no: `hash` is the SHA-256 of the text and the metadata (`schema.py`)                  |
| LangChain `add_start_index` | `start_index` in the metadata (`langchain_text_splitters/base.py`) | yes: `index()` hashes the content and the metadata (`langchain_core/indexing/api.py`) |
| Haystack `DocumentSplitter` | `split_idx_start` in the meta                                      | yes: `Document.id` hashes the content and the meta (`dataclasses/document.py`)        |

Each of the three counts offsets in Python string indexes, that is, in code points.

## Decision

- `RuleColumn` gets an `integer` kind: `{ type: 'integer'; description: string }`. Its value is a `number` that is a safe integer. SQLite keeps it as `INTEGER`, Postgres and SQL Server as `BIGINT`, as each destination keeps an `integer` column of a stream. A value that is not a safe integer fails its input with an error that names the column.
- `Chunking` gives two content columns, `text` and `tokens`, and two place columns, `start` and `end` (ADR 0026 of elt). `tokens` is `tokenizer.count(text)`. `start` and `end` are offsets in code points in the text that `read()` gives, the columns of `fields` joined with line breaks; `end` is exclusive. The text of the chunk is the slice from `start` to `end`.
- The offsets are place columns, as LlamaIndex keeps them out of the hash of a node. An edit before a chunk moves its offsets and keeps its part hash, so the chunk keeps its vector. `tokens` comes from the text only, so it is a content column.

## Considered Options

- **Integer rule columns later.** A reader cannot cite or highlight a chunk until then.
- **`tokens` only.** The same: no offsets for a reader.
- **Offsets in the part hash, as LangChain's `index()` and Haystack.** An edit near the start of a document gives each later chunk a new part hash, and the model embeds each of them again.
- **Offsets in UTF-16 code units, as a JavaScript string counts.** `substr` of SQLite and `substring` of Postgres count code points, and so does each leader.
- **Offsets in code points as place columns, and `tokens` as a content column.** This option was selected.

## Consequences

- A reader in SQL finds the text of a chunk in its document with `substr(content, start + 1, end - start)` in SQLite and `substring(content from start + 1 for end - start)` in Postgres. SQL Server counts code points in `SUBSTRING` only with a UTF-8 or supplementary-character (`_SC`) collation; with another collation, a character outside the Basic Multilingual Plane counts as two.
- A reader in JavaScript converts with `[...text].slice(start, end).join('')`.
- A chunk that only moved is written again in the parts table with its new offsets. Its row in the dataset of vectors does not change.

Sources: #4737.
