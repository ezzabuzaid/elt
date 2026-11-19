# Recipe: Cut documents into chunks, then embed each chunk

**Use case.** A user keeps proposals in a folder. A search must find the part of a proposal that matches, not only the proposal. Some proposals count more tokens than the embedding model takes. Each document must be cut into chunks that the model takes, and each chunk must get its own vector. When a document changes, only the chunk texts that changed may go to the model again.

**What you need.** The chain of the [README](../../README.md) example on SQLite: a source whose stream gives files, a `LocalFiles` and a `DocumentParser` for `DocumentText`, a `View` of the text that the parser read, `Chunking`, a `View` of the chunk texts by part hash, and `Embedding`.

## The steps

1. Declare the computed dataset `document_text` with `DocumentText`, as the [recipe of elt-sqlite](../../../destinations/sqlite/docs/recipes/search-the-text-of-stored-files.md) does.
2. Declare the view `document_text_readable` with the text that the parser read. A computed dataset reads a table or a view, never another computed dataset ([ADR 0027 of elt](../../../elt/docs/adr/0027-a-dataset-reads-the-parts-of-a-computed-dataset-through-a-view.md)).
3. Declare the computed dataset `document_chunks` with `Chunking`. Give it the tokenizer of the embedding model, `maxTokens` and `overlapTokens`.
4. Declare the view `document_chunk_texts`, which gives the part hash of each chunk as its `id`.
5. Declare the computed dataset `document_chunk_vectors` with `Embedding`, keyed by `id`.
6. Run the pipeline. Join `document_chunks_parts` to `document_chunk_vectors` on `part_hash = id`.

## The program

The program uses small sizes, 40 and 20 tokens, so that a short proposal gives several chunks. The README example uses 800 and 400. The embedding model is a local stand-in with no network: the vector of a text counts each letter a to z, in 26 dimensions. `TextParser` reads a plain text file. Run from `packages/chunking` after `nx run chunking:build`, with `node cut-documents-into-chunks.ts`.

```ts title="cut-documents-into-chunks.ts"
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Result,
} from '@ai-sdk/provider';
import { TemporaryFiles } from '@zukhruf/fs';
import { open } from '@zukhruf/sqlite-open';
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';

import { Chunking } from '@eltjs/chunking';
import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  DocumentParser,
  DocumentText,
  Gauge,
  LocalFiles,
  Pipeline,
  Source,
  Stream,
} from '@eltjs/elt';
import {
  ComputedDataset,
  SQLiteDestination,
  SQLiteSyncHistory,
  View,
} from '@eltjs/elt-sqlite';
import { Embedding } from '@eltjs/embedding';

// The documents a user keeps in one folder. Each file is one record.
class DocumentsFolder extends Source {
  readonly identity = 'documents-folder';
  readonly documents = new Stream({
    name: 'documents',
    jsonSchema: {
      type: 'object',
      description: 'A file in the folder.',
      properties: { name: { type: 'string', description: 'File name.' } },
      required: ['name'],
    },
    primaryKey: ['name'],
    supportedSyncModes: ['full_refresh'],
    supportsFileTransfer: true,
  });
  protected readonly catalog = new Catalog([this.documents]);
  readonly #folder: string;

  constructor(folder: string) {
    super();
    this.#folder = folder;
  }

  override coverage() {
    return { description: 'Every file in the folder.', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  // This program only runs and never watches, so no watch reads this gauge.
  override changeSignals(streams: readonly Stream[]) {
    const gauge = new (class extends Gauge<number> {
      protected async read() {
        return 0;
      }
    })();
    return [{ gauge, streams, interval: 1000, timeout: 1000 }];
  }

  protected override async *extract(configuration: CopyConfiguration) {
    for (const name of await readdir(this.#folder))
      yield {
        stream: configuration.stream.name,
        data: { name },
        file: join(this.#folder, name),
      };
  }
}

// The text of a plain text file.
class TextParser extends DocumentParser {
  constructor() {
    super('text/plain');
  }

  override async parse(path: string) {
    return readFile(path, 'utf8');
  }
}

// A local embedding model with no network: the vector of a text counts each
// letter a to z. It keeps each text it embeds.
class LetterModel implements EmbeddingModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'recipe';
  readonly modelId = 'letters';
  readonly maxEmbeddingsPerCall = undefined;
  readonly supportsParallelCalls = true;
  readonly embedded: string[] = [];

  async doEmbed({
    values,
  }: EmbeddingModelV4CallOptions): Promise<EmbeddingModelV4Result> {
    this.embedded.push(...values);
    return {
      embeddings: values.map((text) =>
        Array.from(
          { length: 26 },
          (_, letter) =>
            [...text.toLowerCase()].filter(
              (character) => character.charCodeAt(0) - 97 === letter,
            ).length,
        ),
      ),
      warnings: [],
    };
  }
}

const proposal = (title: string) =>
  [
    `${title}: a cold store for the north farm`,
    'The farm loses a fifth of its fruit each summer, because the barn is too warm. A cold store keeps the fruit at four degrees until the trucks come. Each truck takes the fruit to the market in town.',
    'The store needs a slab of concrete, insulated panels and one compressor. The compressor runs on the solar roof in the day and on the grid at night.',
    'The work takes six weeks. The farm pays half, and the cooperative pays the other half from its fund for new buildings.',
  ].join('\n\n');

await using directory = await new TemporaryFiles().directory(
  'cut-documents-into-chunks-',
);
const folder = join(directory.path, 'Documents');
await mkdir(folder);
await writeFile(join(folder, 'proposal.txt'), proposal('Proposal'));
await writeFile(join(folder, 'note.txt'), 'Call the cooperative on Monday.');

const source = new DocumentsFolder(folder);
const files = new LocalFiles({ directory: join(directory.path, 'files') });
const destination = new SQLiteDestination({
  path: join(directory.path, 'documents.sqlite'),
});
const documents = destination.table('documents', (c) => [
  c.text('name').primaryKey(),
  c.text('documentRef').from(source.documents.file.store(files)),
]);
const model = new LetterModel();

const text = new ComputedDataset({
  into: destination,
  name: 'document_text',
  description: 'The text of each stored document.',
  from: [documents],
  compute: new DocumentText({
    parser: () => new TextParser(),
    files: files.directory,
    column: 'documentRef',
  }),
});
const readable = new View({
  into: destination,
  name: 'document_text_readable',
  description: 'The text of each document that the parser read.',
  columns: { ref: 'The ref of the stored file.', content: 'Its text.' },
  sql: "SELECT ref, content FROM document_text WHERE status = 'computed'",
});
const chunks = new ComputedDataset({
  into: destination,
  name: 'document_chunks',
  description: 'The chunks of the text of each document.',
  from: [readable],
  compute: new Chunking({
    tokenizer: { name: 'cl100k_base', count: countTokens },
    maxTokens: 40,
    overlapTokens: 20,
    key: 'ref',
    fields: ['content'],
  }),
});
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
const vectors = new ComputedDataset({
  into: destination,
  name: 'document_chunk_vectors',
  description: 'The vector of each chunk text.',
  from: [chunkTexts],
  compute: new Embedding({
    model,
    dimensions: 26,
    clock: globalThis,
    key: 'id',
    fields: ['text'],
  }),
});

const pipeline = new Pipeline({
  clock: globalThis,
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'documents',
      source,
      destination,
      steps: [new Copy(source.documents, documents)],
    }),
  ],
  derived: [text, readable, chunks, chunkTexts, vectors],
});

const show = () => {
  using database = open(destination.path, { readOnly: true });
  console.table(
    database
      .prepare(
        `SELECT d.name, p.seq, substr(p.part_hash, 1, 8) AS part_hash,
                p.tokens, p.start, p."end", v.status AS vector, p.text
         FROM documents d
         JOIN document_chunks_parts p ON p.ref = d.documentRef
         LEFT JOIN document_chunk_vectors v ON v.id = p.part_hash
         ORDER BY d.name, p.seq`,
      )
      .all(),
  );
  console.log(
    database.prepare('SELECT DISTINCT rule FROM document_chunks').get(),
  );
};

await pipeline.run();
show();
console.log({ embedded: model.embedded.length });

// An edit near the start of the proposal: its title changes.
model.embedded.length = 0;
await writeFile(join(folder, 'proposal.txt'), proposal('Offer'));
await pipeline.run();
show();
console.log({ embedded: model.embedded });
```

Output:

```
┌─────────┬────────────────┬─────┬────────────┬────────┬───────┬─────┬────────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ (index) │ name           │ seq │ part_hash  │ tokens │ start │ end │ vector     │ text                                                                                                                                                  │
├─────────┼────────────────┼─────┼────────────┼────────┼───────┼─────┼────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 0       │ 'note.txt'     │ 0   │ '5498f288' │ 6      │ 0     │ 31  │ 'computed' │ 'Call the cooperative on Monday.'                                                                                                                     │
│ 1       │ 'proposal.txt' │ 0   │ 'd03f071f' │ 28     │ 0     │ 121 │ 'computed' │ 'Proposal: a cold store for the north farm\n\nThe farm loses a fifth of its fruit each summer, because the barn is too warm.'                         │
│ 2       │ 'proposal.txt' │ 1   │ '535a06d5' │ 32     │ 43    │ 189 │ 'computed' │ 'The farm loses a fifth of its fruit each summer, because the barn is too warm. A cold store keeps the fruit at four degrees until the trucks come.'  │
│ 3       │ 'proposal.txt' │ 2   │ '063ddb6f' │ 25     │ 122   │ 239 │ 'computed' │ 'A cold store keeps the fruit at four degrees until the trucks come. Each truck takes the fruit to the market in town.'                               │
│ 4       │ 'proposal.txt' │ 3   │ 'a6747a85' │ 31     │ 241   │ 388 │ 'computed' │ 'The store needs a slab of concrete, insulated panels and one compressor. The compressor runs on the solar roof in the day and on the grid at night.' │
│ 5       │ 'proposal.txt' │ 4   │ '2ae261ce' │ 25     │ 390   │ 508 │ 'computed' │ 'The work takes six weeks. The farm pays half, and the cooperative pays the other half from its fund for new buildings.'                              │
└─────────┴────────────────┴─────┴────────────┴────────┴───────┴─────┴────────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
[Object: null prototype] {
  rule: '@eltjs/chunking@0.6.0 cl100k_base 40/20'
}
{ embedded: 6 }
┌─────────┬────────────────┬─────┬────────────┬────────┬───────┬─────┬────────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ (index) │ name           │ seq │ part_hash  │ tokens │ start │ end │ vector     │ text                                                                                                                                                  │
├─────────┼────────────────┼─────┼────────────┼────────┼───────┼─────┼────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 0       │ 'note.txt'     │ 0   │ '5498f288' │ 6      │ 0     │ 31  │ 'computed' │ 'Call the cooperative on Monday.'                                                                                                                     │
│ 1       │ 'proposal.txt' │ 0   │ '7bb598fc' │ 28     │ 0     │ 118 │ 'computed' │ 'Offer: a cold store for the north farm\n\nThe farm loses a fifth of its fruit each summer, because the barn is too warm.'                            │
│ 2       │ 'proposal.txt' │ 1   │ '535a06d5' │ 32     │ 40    │ 186 │ 'computed' │ 'The farm loses a fifth of its fruit each summer, because the barn is too warm. A cold store keeps the fruit at four degrees until the trucks come.'  │
│ 3       │ 'proposal.txt' │ 2   │ '063ddb6f' │ 25     │ 119   │ 236 │ 'computed' │ 'A cold store keeps the fruit at four degrees until the trucks come. Each truck takes the fruit to the market in town.'                               │
│ 4       │ 'proposal.txt' │ 3   │ 'a6747a85' │ 31     │ 238   │ 385 │ 'computed' │ 'The store needs a slab of concrete, insulated panels and one compressor. The compressor runs on the solar roof in the day and on the grid at night.' │
│ 5       │ 'proposal.txt' │ 4   │ '2ae261ce' │ 25     │ 387   │ 505 │ 'computed' │ 'The work takes six weeks. The farm pays half, and the cooperative pays the other half from its fund for new buildings.'                              │
└─────────┴────────────────┴─────┴────────────┴────────┴───────┴─────┴────────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
[Object: null prototype] {
  rule: '@eltjs/chunking@0.6.0 cl100k_base 40/20'
}
{
  embedded: [
    'Offer: a cold store for the north farm\n' +
      '\n' +
      'The farm loses a fifth of its fruit each summer, because the barn is too warm.'
  ]
}
```

## Why it works

`DocumentText` keeps the text of each stored file. `Chunking` reads it through the view, and gives one output row for each document in `document_chunks`, and one part for each chunk in `document_chunks_parts` ([ADR 0026 of elt](../../../elt/docs/adr/0026-a-rule-can-give-many-parts-for-one-input.md)).

The proposal counts more than 40 tokens. Its title and its first sentence fit in one chunk. The second paragraph counts more than 40 tokens, so the rule cuts it at its sentences, and the chunk with seq 1 starts with the last sentence of the chunk before it, which counts at most 20 tokens. The third and fourth paragraphs fit, so each is one chunk. No chunk counts more than 40 tokens of `cl100k_base`. The note fits, so it is one chunk.

The view `document_chunk_texts` gives each chunk with its part hash as `id`, so `Embedding` keys each vector by the text of its chunk ([ADR 0027 of elt](../../../elt/docs/adr/0027-a-dataset-reads-the-parts-of-a-computed-dataset-through-a-view.md)). After the edit of the title, only the first chunk has a new text and a new part hash. The other chunks of the proposal keep their part hash and their vector, and only their `start` and `end` move by 3, the difference between `Proposal` and `Offer`. The model gets one text in the second run.

## Things to know

- **`start` and `end` count code points** of the text that `read()` gives. `substr(content, start + 1, end - start)` of SQLite gives the text of a chunk ([ADR 0006](../adr/0006-each-chunk-gives-its-offsets-and-its-count-of-tokens.md)).
- **A release of `@eltjs/chunking` or a change of a size cuts each text again.** The rule identity is `@eltjs/chunking@<version> <tokenizer> <maxTokens>/<overlapTokens>` ([ADR 0005](../adr/0005-the-rule-identity-of-a-chunk-is-the-package-version-the-tokenizer-and-the-two-sizes.md)). A chunk text that did not change keeps its part hash, so it keeps its vector.
