# @eltjs/chunking

> **Design on paper, for review.** No code, `package.json` or `tsconfig` exists yet. Each ADR is `proposed, for Ezz's review (2026-11-19)`. Backlog #4737. The engine change that this package needs is in [ADR 0026](../elt/docs/adr/0026-a-rule-can-give-many-parts-for-one-input.md) and [ADR 0027](../elt/docs/adr/0027-a-dataset-reads-the-parts-of-a-computed-dataset-through-a-view.md) of elt.

`Chunking` is a rule of a computed dataset. It cuts the text of each loaded row into chunks. Each chunk counts at most `maxTokens` tokens, as the tokenizer of the embedding model counts them. Then the `Embedding` rule of [`@eltjs/embedding`](../embedding/README.md) makes one vector for each chunk.

Today a computed dataset keeps one output row for each key ([ADR 0002 of elt-sqlite](../destinations/sqlite/docs/adr/0002-a-computed-dataset-keeps-one-output-row-for-each-key.md)), and `read()` gives one key and one input (`packages/elt/src/core/rule.ts:40-42`). Thus a long SharePoint proposal is one vector. When its text counts more than 8,191 tokens, the limit of OpenAI's `text-embedding-3-small`, it is one failed row, and each pass tries it again ([ADR 0007 of elt-sqlite](../destinations/sqlite/docs/adr/0007-each-pass-tries-an-input-at-most-once.md)). One vector of a long text also loses the meaning of each part of it. Ezz chose on 2026-11-19 to solve this in the elt core, not with a SQL view that cuts by characters.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md), and the glossary of [elt](../elt/CONTEXT.md) for the words of all of elt.

## Cut documents into chunks, then embed each chunk

This example works the same for each destination: `elt-sqlite`, `elt-postgresql` and `elt-sqlserver` (#4736). Only the import of `View` and `ComputedDataset` changes.

```ts
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';

import { Chunking } from '@eltjs/chunking';
import { DocumentText } from '@eltjs/elt';
import { ComputedDataset, View } from '@eltjs/elt-sqlite';
import { Embedding } from '@eltjs/embedding';

// 1. The text of each stored document (a computed dataset that exists today).
const text = new ComputedDataset({
  into: destination,
  name: 'document_text',
  description: 'The text of each stored document.',
  from: [documents],
  compute: new DocumentText({
    parser: () => parser,
    files: files.directory,
    column: 'documentRef',
  }),
});

// 2. A computed dataset reads a table or a view, never another computed
//    dataset, so a view gives the text that the parser read.
const readable = new View({
  into: destination,
  name: 'document_text_readable',
  description: 'The text of each document that the parser read.',
  columns: { ref: 'The ref of the stored file.', content: 'Its text.' },
  sql: "SELECT ref, content FROM document_text WHERE status = 'computed'",
});

// 3. One output row for each document, and one part for each chunk.
const chunks = new ComputedDataset({
  into: destination,
  name: 'document_chunks',
  description: 'The chunks of the text of each document.',
  from: [readable],
  compute: new Chunking({
    tokenizer: { name: 'cl100k_base', count: countTokens },
    maxTokens: 800,
    overlapTokens: 400,
    key: 'ref',
    fields: ['content'],
  }),
});

// 4. A view gives each chunk with its part hash as its key.
const chunkTexts = new View({
  into: destination,
  name: 'document_chunk_texts',
  description: 'The text of each chunk, by its part hash.',
  columns: {
    id: 'The part hash of the chunk.',
    text: 'The text of the chunk.',
  },
  sql: 'SELECT part_hash AS id, text FROM document_chunks_parts',
});

// 5. One vector for each chunk text.
const vectors = new ComputedDataset({
  into: destination,
  name: 'document_chunk_vectors',
  description: 'The vector of each chunk text.',
  from: [chunkTexts],
  compute: new Embedding({
    model,
    clock: globalThis,
    key: 'id',
    fields: ['text'],
  }),
});

new Pipeline({
  history,
  connections,
  derived: [text, readable, chunks, chunkTexts, vectors],
});
```

- `tokenizer` is the tokenizer of the embedding model. `text-embedding-3-small` uses `cl100k_base`. The package does not choose a tokenizer, because each model has its own ([ADR 0002](./docs/adr/0002-the-host-s-tokenizer-measures-each-chunk-and-no-chunk-passes-the-limit.md)).
- `maxTokens` and `overlapTokens` have no default. The example uses the defaults of OpenAI's own file search, 800 and 400 ([ADR 0004](./docs/adr/0004-the-host-gives-the-two-sizes-in-tokens-and-the-overlap-is-at-most-half-a-chunk.md)).
- `key` and `fields` are as in `Embedding`: the column that identifies a row, and the columns whose text the rule cuts, joined with line breaks. A row with no text in these columns has no chunks.
- A search joins `document_chunk_vectors` to `document_chunks_parts` on `id = part_hash`, and gets the ref, the order and the text of each chunk that matched.

## The signatures

```ts
// @eltjs/elt (ADR 0026 of elt)
export type TableRuleResult<Output> =
  | { readonly parts: readonly [Output, ...Output[]] }
  | { readonly empty: true }
  | { readonly error: string }
  | { readonly gone: true };

export abstract class TableRule<Input, Output> {
  abstract readonly key: {
    readonly name: string;
    readonly description: string;
  };
  abstract readonly output: Readonly<Record<string, RuleColumn>>; // the columns of each part
  abstract readonly batch: number;
  abstract readonly concurrency: number;
  abstract read(
    row: LoadedRow,
  ): { readonly key: string; readonly input: Input } | null;
  abstract identity(input: Input): Promise<string | null>;
  abstract compute(
    inputs: readonly Input[],
    signal?: AbortSignal,
  ): Promise<readonly TableRuleResult<Readonly<Record<string, Output>>>[]>;
}

// @eltjs/chunking
export type Tokenizer = {
  // The name of the vocabulary, such as cl100k_base. It is part of the rule identity.
  readonly name: string;
  // How many tokens the model counts in text.
  count(text: string): number;
};

export class Chunking extends TableRule<string, string> {
  constructor(options: {
    tokenizer: Tokenizer;
    maxTokens: number;
    overlapTokens: number;
    key: string;
    fields: readonly string[];
  });
}
```

`Chunking` has one output column, `text`. Its batch is 32 inputs and its concurrency is 1: the work is synchronous, so calls side by side gain nothing, and a batch keeps the commits few.

## What happens underneath

| Call or event                              | What happens                                                                                                                                                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new Chunking({ … })`                      | Refuses `maxTokens` below 1, `overlapTokens` below 0, and `overlapTokens` above half of `maxTokens`, with a `RangeError` that names the value                                                                                                 |
| `read(row)`                                | Gives the key and the text of `fields`, joined with line breaks. `null` when the row has no key or no text                                                                                                                                    |
| `identity(text)`                           | `@eltjs/chunking@<version> <tokenizer.name> <maxTokens>/<overlapTokens>`, the same for each input ([ADR 0005](./docs/adr/0005-the-rule-identity-of-a-chunk-is-the-package-version-the-tokenizer-and-the-two-sizes.md))                        |
| `compute(texts)`, a text that fits         | One part: the text with its white space at the start and the end removed                                                                                                                                                                      |
| `compute(texts)`, a longer text            | Cuts at the largest boundary that fits: paragraph, line, sentence, word, grapheme ([ADR 0003](./docs/adr/0003-a-chunk-ends-at-the-largest-boundary-that-fits.md)). Counts the text of each chunk with `tokenizer.count`                       |
| `compute(texts)`, overlap                  | Each chunk after the first starts with the last whole pieces of the chunk before it, up to `overlapTokens` tokens. Each chunk starts after the start of the chunk before it                                                                   |
| a refresh writes an output                 | Writes the output row and its parts in one transaction. A part with the same values keeps its commit. A part beyond the new count goes into the history ([ADR 0026 of elt](../elt/docs/adr/0026-a-rule-can-give-many-parts-for-one-input.md)) |
| the text of a document changes             | Its input hash changes, so the refresh cuts it again. The chunks before the change have the same text, the same part hash, and keep their vectors. Only new chunk texts go to the model                                                       |
| the package is released, or a size changes | The rule identity changes, so the next refresh cuts each text again. Each chunk text that did not change keeps its part hash and its vector                                                                                                   |
| the document is removed                    | The refresh deletes its output row and its parts. The vector of a part hash that no chunk has any more is deleted by the refresh of the vectors                                                                                               |

## The columns

The computed dataset `document_chunks` has two reader views. `document_chunks` has one row for each key, with the columns of each computed dataset: the key, `input_hash`, `rule`, `status` and `error`. `document_chunks_parts` has one row for each chunk:

| Column      | Holds                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| the key     | the key of the input, with the name that the rule gives, for example `ref`                                |
| `seq`       | the order of the chunk in its text, from 0                                                                |
| `part_hash` | the SHA-256 of the columns of the rule of the part. Two chunks with the same text have the same part hash |
| `text`      | the text of the chunk: a slice of the input, with no white space at the start or the end                  |

A key whose status is `failed` or `empty` has no parts.

## When something fails

| Failure                                   | What happens                                                                                             | What the caller does                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `RangeError` from the constructor         | A size that is not possible, such as an overlap of more than half a chunk                                | Change the size                               |
| One grapheme counts more than `maxTokens` | A rule failure of that input: the output row is `failed`, and the error gives the offset of the grapheme | Give a larger `maxTokens`                     |
| `tokenizer.count` throws                  | A rule failure of each input of the call. The next pass tries again (ADR 0004 of elt)                    | Fix the tokenizer                             |
| A text that the model still refuses       | `Embedding` splits its call in halves, and only the row of that chunk fails                              | Check that the tokenizer is that of the model |

## The map

| Now                                                                                                            | Later                                                                                                                                                  | Never                                                                                                    |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `TableRule` and parts in `@eltjs/elt`, and a parts table in each destination (ADR 0026 of elt)                 | Integer rule columns, for `start`, `end` and `tokens` of each chunk, so that a reader can cite and highlight a chunk (open question 5)                 | A chunk size in characters for a model whose limit is in tokens (Ezz, 2026-11-19)                        |
| `part_hash`, so that a dataset that reads the parts keys them by content                                       | `from` names a computed dataset, with no view between them, when a third host writes the same view (ADR 0027 of elt)                                   | A chunker inside `Embedding`, as pgai's vectorizer has its `chunking` inside it (ADR 0001)               |
| `Chunking`: boundaries of Unicode text segmentation, a fit that the host's tokenizer checks, overlap in tokens | Boundaries from the structure of a document, such as headings and tables, when a `DocumentParser` gives structure (Unstructured's `chunk_by_title`)    | A random id for each chunk (LlamaIndex `uuid4`, .NET `Guid.NewGuid()`): a refresh compares states by key |
|                                                                                                                | Semantic breakpoints from the vectors of sentences (LlamaIndex `SemanticSplitterNodeParser`, .NET `SemanticSimilarityChunker`). This needs model calls | A default chunk size                                                                                     |
|                                                                                                                | A ready `Tokenizer` for OpenAI's vocabularies, when a third host writes the same two lines over `gpt-tokenizer`                                        | A vocabulary that loads from the network at run time (LangChain's `tiktoken.pages.dev`)                  |
|                                                                                                                | A `locale` for sentence boundaries                                                                                                                     | A cut inside a character (LangChain's `TokenTextSplitter`)                                               |

## The same concepts in other systems

| Here               | LangChain                                                                                                                                                        | LlamaIndex                                                                                                                              | pgai vectorizer                                                                                                                 | Unstructured                                                                                                         | Haystack                                                                                                                      | .NET                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Chunking`         | [`RecursiveCharacterTextSplitter`, `TokenTextSplitter`](https://github.com/langchain-ai/langchainjs/blob/main/libs/langchain-textsplitters/src/text_splitter.ts) | [`SentenceSplitter`](https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/node_parser/text/sentence.py) | [`ai.chunking_recursive_character_text_splitter`](https://github.com/timescale/pgai/blob/main/docs/vectorizer/api-reference.md) | [`chunk_by_title`, `basic`](https://github.com/Unstructured-IO/unstructured/blob/main/unstructured/chunking/base.py) | [`DocumentSplitter`](https://github.com/deepset-ai/haystack/blob/main/haystack/components/preprocessors/document_splitter.py) | [`DocumentTokenChunker`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.DataIngestion/Chunkers/DocumentTokenChunker.cs) |
| `maxTokens`        | `chunkSize`, 1,000 characters (length function `text.length`)                                                                                                    | `chunk_size`, 1,024 tokens                                                                                                              | `chunk_size`, 800 characters                                                                                                    | `max_characters` 500, or `max_tokens` with a `tokenizer`                                                             | `split_length`, 200 words; `split_by="token"` also                                                                            | `MaxTokensPerChunk`, 2,000 tokens                                                                                                                          |
| `overlapTokens`    | `chunkOverlap`, 200; refuses overlap ≥ size                                                                                                                      | `chunk_overlap`, 200 tokens                                                                                                             | `chunk_overlap`, 400 characters                                                                                                 | `overlap` 0, only inside a split element unless `overlap_all`                                                        | `split_overlap`, 0                                                                                                            | `OverlapTokens`, 500                                                                                                                                       |
| `tokenizer`        | `lengthFunction`; `encodingName` `gpt2` for the token splitter                                                                                                   | `tokenizer` callable; default tiktoken for `gpt-3.5-turbo` (`cl100k_base`)                                                              | none: counts characters; the embedder knows the 8,191-token limit and records the error                                         | `tokenizer`, a tiktoken name                                                                                         | `tokenizer_encoding`, default `o200k_base`                                                                                    | `Tokenizer` of `Microsoft.ML.Tokenizers`, required                                                                                                         |
| Boundaries         | `["\n\n", "\n", " ", ""]`                                                                                                                                        | paragraphs (`"\n\n\n"`), NLTK sentences, a regex of `,.;。？！`, words, characters                                                      | `["\n\n", "\n", ".", "?", "!", " ", ""]`                                                                                        | the elements of the document: titles, text, tables                                                                   | words, sentences, pages, lines                                                                                                | the elements of the document, then tokens                                                                                                                  |
| An over-size chunk | logs a warning and keeps it (`text_splitter.js`, "Created a chunk of size …")                                                                                    | splits to characters                                                                                                                    | the model refuses it, and the error stays                                                                                       | splits the element                                                                                                   | no limit of tokens, unless `split_by="token"`                                                                                 | splits by tokens                                                                                                                                           |
| Key of a chunk     | none                                                                                                                                                             | `uuid4()` (`node_utils.py`, `default_id_func`), with `ref_doc_id`                                                                       | `(source primary key, chunk_seq)` and `embedding_uuid`                                                                          | none                                                                                                                 | the SHA-256 of the content and the metadata, with `source_id` and `split_id`                                                  | `Guid.NewGuid()`, with `documentid`                                                                                                                        |
| The source changes | the caller decides                                                                                                                                               | `IngestionPipeline` with `UPSERTS` deletes the nodes of the document and adds the new ones                                              | deletes each embedding of the source row, then adds the new chunks (`vectorizer.py`, `_delete_embeddings`)                      | the caller decides                                                                                                   | the caller decides                                                                                                            | `VectorStoreWriter` adds the new chunks, then deletes the chunks that the document had                                                                     |

OpenAI's own file search cuts by tokens: `max_chunk_size_tokens` 800 (100 to 4,096) and `chunk_overlap_tokens` 400, at most half of a chunk (the `StaticFileChunkingStrategy` type of the `openai` SDK). In Go, `langchaingo/textsplitter` copies LangChain: `RecursiveCharacter` with `utf8.RuneCountInString` and `TokenSplitter` with tiktoken-go.

Each leader with a key for each chunk keeps the order of the chunk in its source (pgai `chunk_seq`, Haystack `split_id`). Each leader that keeps chunks in step with a source replaces all the chunks of the source when it changes. elt does the same, and a part with the same values keeps its commit.

## Why no npm package does the job

The requirements as checks: (1) each chunk counts at most `maxTokens` tokens of the model's vocabulary; (2) overlap in tokens; (3) a cut at the largest boundary that fits, never inside a character; (4) the same text gives the same chunks; (5) no network at run time; (6) the tokenizer is the caller's. Each candidate was probed in an empty folder on 2026-11-19, Node 26.13.0.

| Package                    | Version, released  | Downloads (last week) | Install footprint                                                    | Why it fails                                                                                                                                                                                                                                                                                                               |
| -------------------------- | ------------------ | --------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@langchain/textsplitters` | 1.0.2, 2026-09-27  | 2,058,170             | 152 KB, and the peer `@langchain/core` (13 packages, with langsmith) | `TokenTextSplitter` decodes windows of tokens: 13 of 22 chunks of a text with accents, emoji and Japanese held U+FFFD (3). It loads the vocabulary from `tiktoken.pages.dev` (5). `RecursiveCharacterTextSplitter` sums the lengths of pieces and only warns when a chunk is too long (1); it has no sentence boundary (3) |
| `@llamaindex/node-parser`  | 2.0.23, 2026-03-09 | 138,928               | 36 packages, `tree-sitter` with an install script                    | Its nodes are LlamaIndex documents with `uuid4` ids (4); a framework for one function                                                                                                                                                                                                                                      |
| `@chonkiejs/core`          | 0.0.12, 2026-10-03 | 27,088                | 4 packages, a native tree-sitter binary for each platform            | Its default tokenizer counts characters. Tokens need `@chonkiejs/token`, which takes `@huggingface/transformers` and loads the tokenizer from the Hugging Face Hub (5). Version 0.0.x                                                                                                                                      |
| `@mastra/rag`              | 2.8.1, 2026-11-17  | 279,441               | 211 packages (AWS Bedrock client and others)                         | A framework of retrieval; the footprint is for one function                                                                                                                                                                                                                                                                |
| `llm-splitter`             | 0.3.0, 2026-08-25  | 20,255                | 68 KB, 1 package                                                     | It packs the units of a splitter function, with no boundaries: with a token splitter, 9 of 31 chunks started inside a word (3)                                                                                                                                                                                             |
| `semantic-chunking`        | 3.0.2, 2026-08-14  | 250                   | `@huggingface/transformers` and others                               | Semantic chunking with a local model; not a token fit                                                                                                                                                                                                                                                                      |

No package does all six. The cut is the knowledge of this package. The count is not: `gpt-tokenizer` does it.

## Tokenizers for OpenAI's vocabularies in JavaScript

| Package                   | Version, released  | Downloads (last week) | Footprint                                                              | Probe on 420,000 tokens of `cl100k_base`                                                       |
| ------------------------- | ------------------ | --------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `gpt-tokenizer`           | 4.1.2, 2026-11-10  | 2,721,243             | 1 package, no dependencies, 30 MB (each vocabulary is its own subpath) | 41 ms. `isWithinTokenLimit` answered `false` for 8,191 in 2 ms. Same count as js-tiktoken. MIT |
| `js-tiktoken`             | 1.0.21, 2025-08-09 | 13,130,133            | 2 packages, 21 MB                                                      | 481 ms                                                                                         |
| `tiktoken`                | 1.0.22, 2025-08-09 | 2,234,448             | WASM                                                                   | not probed: a WASM binary to load in each runtime                                              |
| `@huggingface/tokenizers` | 0.2.0, 2026-09-07  | 4,126,201             | 1 package                                                              | runs a `tokenizer.json`; OpenAI ships no such file, so a host must get one                     |
| `tokenx`                  | 2.2.1, 2026-11-14  | 2,546,118             | 2 kB                                                                   | an estimate ("95%+ average accuracy"): no limit holds on an estimate                           |

`js-tiktoken` names `cl100k_base` for `text-embedding-3-small` (`getEncodingNameForModel`). deepagents (`packages/context/src/lib/estimate.ts`) and datahub already take `gpt-tokenizer`. Node 26 has no tokenizer. It has `Intl.Segmenter`, which this package uses for boundaries.

## Who uses what

| Package or host                                    | What it takes                                                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| datahub, `apps/semantic-layer/elt` (backlog #4740) | `Chunking` over `sharepoint_document_text`, then `Embedding` with `text-embedding-3-small`, kept in Azure SQL (#4736) |
| `@eltjs/elt`                                       | gives `TableRule`, `TableRuleResult`, `LoadedRow` and `RuleColumn`                                                    |
| each destination                                   | keeps the parts of a `TableRule` (ADR 0026 of elt)                                                                    |
| `gpt-tokenizer`                                    | taken by the host, not by this package, for a `Tokenizer` of OpenAI's vocabularies                                    |

## Who owns each job

| Job                                                                     | Who can know it                         | Owner                                        |
| ----------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------- |
| Which columns hold the key and the text                                 | the host                                | the host: `key`, `fields`                    |
| Which tokenizer the model uses, and its limit                           | the host, which picks the model         | the host: `tokenizer`, `maxTokens`           |
| How many tokens a text counts                                           | the tokenizer library                   | `gpt-tokenizer`, behind the `Tokenizer` port |
| Where to cut, how to pack, the overlap, the fit                         | the domain of chunking                  | `@eltjs/chunking`                            |
| The rule identity of the chunks                                         | this package: its version and its sizes | `@eltjs/chunking`                            |
| One input to many parts: store, replace, history, positions             | the engine and each destination         | `@eltjs/elt` and each destination (ADR 0026) |
| Which part columns go to the model, a filter, a title before each chunk | the host                                | the host's `View` (ADR 0027)                 |
| The vector of each chunk                                                | the embedding model                     | `@eltjs/embedding`, unchanged                |
| The rank of a document from its chunks, such as its best chunk (MaxP)   | the host                                | the host's search                            |

## Open questions for Ezz

1. **The name of the engine kind.** `TableRule`, after the SQL table function (Postgres set-returning function, Snowflake UDTF, Hive UDTF), with "part" for each row it gives? Or `PartsRule`, or `SplitRule`?
2. **The order with #4649.** SQL Server is the third destination that keeps computed datasets, and its paper asks to move the refresh into elt ([ADR 0012 of elt-sqlserver](../destinations/sqlserver/docs/adr/0012-the-third-destination-moves-the-rules-that-the-three-destinations-share-into-elt.md)). Build the parts once in that shared refresh (recommended), or in the SQLite and Postgres copies now, mirrored, and in SQL Server later?
3. **The key of a chunk for the model.** The part hash, so that a chunk whose text did not change keeps its vector when the chunks before it move? Or `ref` and `seq`, so that each moved chunk is embedded again?
4. **The sizes for SharePoint proposals.** OpenAI's file search defaults (800 and 400), datahub's vector store today (4,096 and 1,365, `apps/backend/src/core/openai/store/vector-store.ts`), or an eval as for staff search (#3350)?
5. **Offsets and counts of each chunk.** `start`, `end` and `tokens` need an integer rule column. Add it now, beside the `vector(n)` column of [ADR 0007 of elt-sqlserver](../destinations/sqlserver/docs/adr/0007-a-rule-column-can-be-a-vector-with-a-fixed-number-of-dimensions.md), or later?
6. **The limit of the overlap.** At most half of a chunk, as OpenAI, or below a chunk, as LangChain and .NET?

## Decisions

- [ADR 0001](./docs/adr/0001-chunking-is-a-rule-of-its-own-package-that-runs-before-the-embedding.md): chunking is a rule of its own package that runs before the embedding.
- [ADR 0002](./docs/adr/0002-the-host-s-tokenizer-measures-each-chunk-and-no-chunk-passes-the-limit.md): the host's tokenizer measures each chunk, and no chunk passes the limit.
- [ADR 0003](./docs/adr/0003-a-chunk-ends-at-the-largest-boundary-that-fits.md): a chunk ends at the largest boundary that fits.
- [ADR 0004](./docs/adr/0004-the-host-gives-the-two-sizes-in-tokens-and-the-overlap-is-at-most-half-a-chunk.md): the host gives the two sizes in tokens, and the overlap is at most half a chunk.
- [ADR 0005](./docs/adr/0005-the-rule-identity-of-a-chunk-is-the-package-version-the-tokenizer-and-the-two-sizes.md): the rule identity of a chunk is the package version, the tokenizer and the two sizes.
- In elt: [ADR 0026](../elt/docs/adr/0026-a-rule-can-give-many-parts-for-one-input.md), a rule can give many parts for one input, and [ADR 0027](../elt/docs/adr/0027-a-dataset-reads-the-parts-of-a-computed-dataset-through-a-view.md), a dataset reads the parts of a computed dataset through a view.
