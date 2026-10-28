# Recipe: Search the text of stored files with SQL

**Use case.** A user keeps documents in a folder: invoices, a lease, scans. The user wants to find a document by its words, with SQL, for example each document that says "invoice". The copy must store each file, and it must not wait while each file is parsed. A file that the parser cannot read must not fail the run.

**What you need.** A source whose stream gives files, a `LocalFiles` that keeps the stored files, and a `DocumentParser`. On a Mac, `MacOSDocumentParser` of `@workspace/source-apple-macos` reads text, HTML, Word, PDF and vCard files.

## The steps

1. Declare a column that stores the file: `c.text('documentRef').from(source.documents.file.store(files))`. The column holds the ref of the stored file.
2. Declare a `ComputedDataset` with the rule `DocumentText`. Give it the table of the copy in `from`, the folder of the stored files in `files`, and the column of the refs in `column`.
3. Run the pipeline. After the passes, the pipeline refreshes the computed dataset: the rule reads the text of each stored file.
4. Join the reader view of the copy to the view of the computed dataset, on `ref`.

## The program

The source of this program reads a folder with three files: a text invoice, an HTML lease, and a file named `scan.pdf` that is not a PDF.

```ts title="search-stored-files.ts"
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  DocumentText,
  LocalFiles,
  Pipeline,
  Source,
  type SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import {
  ComputedDataset,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { MacOSDocumentParser } from '@workspace/source-apple-macos/macos-document-parser';

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

  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
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

const directory = await mkdtemp(join(tmpdir(), 'search-stored-files-'));
const folder = join(directory, 'Documents');
await mkdir(folder);
await writeFile(
  join(folder, 'invoice-4471.txt'),
  'Careem invoice 4471: 12.50 JOD',
);
await writeFile(
  join(folder, 'lease.html'),
  '<h1>Lease</h1><p>The flat on Rainbow Street, paid each month.</p>',
);
await writeFile(join(folder, 'scan.pdf'), 'These bytes are not a PDF.');

const source = new DocumentsFolder(folder);
const files = new LocalFiles({ directory: join(directory, 'files') });
const sqlite = new SQLiteDestination({
  path: join(directory, 'documents.sqlite'),
});
const documents = sqlite
  .table('raw_documents', (c) => [
    c.text('name').primaryKey(),
    c.text('documentRef').from(source.documents.file.store(files)),
  ])
  .withReaderView('documents');

const pipeline = new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'documents',
      source,
      destination: sqlite,
      steps: [new Copy(source.documents, documents)],
    }),
  ],
  derived: [
    new ComputedDataset({
      into: sqlite,
      name: 'document_text',
      description: 'The text of each stored document.',
      from: [documents],
      compute: new DocumentText({
        parser: () => new MacOSDocumentParser(),
        files: files.directory,
        column: 'documentRef',
      }),
    }),
  ],
});

await pipeline.run();

using database = new DatabaseSync(sqlite.path, { readOnly: true });
const text = database
  .prepare(
    `SELECT d.name, t.status, t.content, t.error
     FROM documents d JOIN document_text t ON t.ref = d.documentRef
     ORDER BY d.name`,
  )
  .all()
  .map(({ error, ...row }) => ({
    ...row,
    // The parser's error ends with the reason.
    error: error === null ? null : String(error).trim().split('\n').at(-1),
  }));
console.log(text);
const found = database
  .prepare(
    `SELECT d.name FROM documents d
     JOIN document_text t ON t.ref = d.documentRef
     WHERE t.content LIKE '%invoice%'`,
  )
  .all()
  .map(({ name }) => name);
console.log({ found });
await rm(directory, { recursive: true, force: true });
```

Output:

```
[
  {
    name: 'invoice-4471.txt',
    status: 'computed',
    content: 'Careem invoice 4471: 12.50 JOD',
    error: null
  },
  {
    name: 'lease.html',
    status: 'computed',
    content: 'Lease\nThe flat on Rainbow Street, paid each month.\n',
    error: null
  },
  {
    name: 'scan.pdf',
    status: 'failed',
    content: null,
    error: 'execution error: Error: Error: Cannot read PDF (-2700)'
  }
]
{ found: [ 'invoice-4471.txt' ] }
```

## Why it works

The copy only stores each file, so the pass does not wait for a parser. `LocalFiles` names each stored file by the SHA-256 of its bytes, and the column `documentRef` holds that ref. After the passes, the pipeline refreshes `document_text`. The rule `DocumentText` reads the ref of each loaded row, and the parser reads the text of the stored file. The computed dataset keeps one output row for each ref. See [ADR 0002](../adr/0002-a-computed-dataset-keeps-one-output-row-for-each-key.md).

The parser cannot read `scan.pdf`. That is a rule failure: its output row has the status `failed` and the reason, and the run resolves. See [ADR 0004 of elt](../../../../elt/docs/adr/0004-a-rule-failure-stays-on-its-output.md).

## Things to know

- **A second run reads no file again** when the files and the parser did not change. It tries `scan.pdf` again, because its status is `failed`.
- **The same file in two rows is read one time.** Two rows that hold the same bytes have one ref, so they share one output row.
- **Under a watch, the text comes after the rows.** The watch refreshes in the background, so a reader can see a new row before its text. See [ADR 0003 of elt](../../../../elt/docs/adr/0003-a-watch-refreshes-in-the-background-one-refresh-at-a-time.md).
- **Images and audio need more formats.** Give `MacOSDocumentParser` an image format with an OCR pool, or an audio format with a speech model.
- **A different parser reads each file again** that it handles, because the rule identity of each file changed. See [ADR 0005 of elt](../../../../elt/docs/adr/0005-an-output-is-made-again-when-its-rule-identity-changes.md).
