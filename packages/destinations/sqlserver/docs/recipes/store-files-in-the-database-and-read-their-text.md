# Recipe: Store files in the database and read their text

**Use case.** A host copies the documents of a library into SQL Server, and a computed dataset keeps the text of each document. The writer runs in a container that a deploy or a restart makes again with a fresh disk, such as an App Service container. A folder of `LocalFiles` would be empty on the new disk, so the files must stay in the database with the rows that name them.

**What you need.** A source whose stream gives files, a `SqlServerDestination`, a `SqlServerSyncHistory` and a `DocumentParser`. The database must be SQL Server 2025 or Azure SQL, with `READ_COMMITTED_SNAPSHOT` and `ALLOW_SNAPSHOT_ISOLATION` on (see "Load a stream into SQL Server" in the [README](../../README.md)).

## The steps

1. Declare the ref column with `.store(destination.files())`, and give `destination.files()` to `DocumentText`.
2. Run a pass. The copy stores each file in `_warehouse._elt_files`, and the refresh reads each file from there.
3. Run the same declarations on a new host, with a parser of a new identity. No folder holds the files, and the source gives nothing new: the refresh reads each file again from the database.

## The program

The program reads the ADO.NET connection string from `SQLSERVER_LOGIN`. It ran on SQL Server 2025 in Docker, in an empty database with row versioning on. Run from `packages/destinations/sqlserver` after `nx run elt-sqlserver:build`, with `SQLSERVER_LOGIN='Server=…;Database=…;User Id=…;Password=…' node store-files-in-the-database-and-read-their-text.ts`.

```ts title="store-files-in-the-database-and-read-their-text.ts"
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Catalog,
  Connection,
  Copy,
  DocumentParser,
  DocumentText,
  Pipeline,
  Source,
  Stream,
} from '@eltjs/elt';
import {
  ComputedDataset,
  SqlServerDestination,
  SqlServerSyncHistory,
} from '@eltjs/elt-sqlserver';
import { SqlServerDatabase } from '@eltjs/sdk-microsoft-sql-server';

const login = process.env.SQLSERVER_LOGIN;
if (login === undefined) throw new Error('Set SQLSERVER_LOGIN');

// The documents of a library, each downloaded into a staging folder that the
// source removes after the pass, as a cloud source downloads its files.
class Library extends Source {
  readonly identity = 'library';
  readonly stream = new Stream({
    name: 'documents',
    jsonSchema: {
      type: 'object',
      description: 'A document of the library.',
      properties: { id: { type: 'string', description: 'Document id.' } },
      required: ['id'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
    supportsFileTransfer: true,
  });
  protected readonly catalog = new Catalog([this.stream]);
  documents: Record<string, string | Uint8Array> = {};

  override coverage() {
    return { description: 'Every document.', selection: {} };
  }
  override async currentAsOf() {
    return null;
  }
  override changeSignals() {
    return [];
  }
  protected override async open() {
    return new AsyncDisposableStack();
  }
  protected override async *extract() {
    const staging = await mkdtemp(join(tmpdir(), 'library-'));
    try {
      for (const [name, content] of Object.entries(this.documents)) {
        await writeFile(join(staging, name), content);
        yield {
          stream: 'documents',
          data: { id: name },
          file: join(staging, name),
        };
      }
    } finally {
      await rm(staging, { recursive: true });
    }
  }
}

// Reads a text file; a file of another extension has no text.
class TextParser extends DocumentParser {
  async parse(path: string) {
    return (await readFile(path, 'utf8')).slice(0, 40);
  }
  override async identityFor({ name }: { name: string }) {
    return name.endsWith('.txt') ? this.identity : null;
  }
}

// The same declarations on each host: no folder, only the database.
function host(parser: DocumentParser, source: Library) {
  const destination = new SqlServerDestination({ login: login! });
  const documents = destination.table('documents', (c) => [
    c.text('id'),
    c.text('documentRef').from(source.stream.file.store(destination.files())),
  ]);
  return new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login: login! }),
    connections: [
      new Connection({
        name: 'library',
        source,
        destination,
        steps: [
          new Copy(source.stream, documents, {
            syncMode: 'full_refresh',
            destinationSyncMode: 'append',
          }),
        ],
      }),
    ],
    derived: [
      new ComputedDataset({
        into: destination,
        name: 'document_text',
        description: 'The text of each stored document.',
        from: [documents],
        compute: new DocumentText({
          parser: () => parser,
          files: destination.files(),
          column: 'documentRef',
        }),
      }),
    ],
  });
}

await using admin = await new SqlServerDatabase(login).connect(globalThis);
const show = async (title: string, sql: string) => {
  console.log(title);
  console.table(await admin.query(sql));
};

const source = new Library();
source.documents = {
  'invoice.txt': 'Invoice 1042: 3 solar panels',
  'scan.bin': new Uint8Array(9 * 1024 * 1024).fill(7),
};
await host(new TextParser('text-v1'), source).run();
await show(
  'marts.documents joined to marts.document_text:',
  `SELECT d.[id], t.[status], t.[content] FROM marts.documents d JOIN marts.document_text t ON t.[ref] = d.[documentRef] ORDER BY d.[id]`,
);
await show(
  '_warehouse._elt_files:',
  `SELECT LEFT([scope], 8) AS [scope], LEFT([name], 12) + '…' + RIGHT([name], 4) AS [name], [n], DATALENGTH([bytes]) AS [bytes] FROM _warehouse._elt_files ORDER BY [name], [n]`,
);

// A new container: the staging folder is gone, the library gives nothing
// new, and the parser has a new identity, so each text file is read again
// from the database.
source.documents = {};
await host(new TextParser('text-v2'), source).run();
await show(
  'marts.document_text after a run on a new host:',
  `SELECT LEFT([ref], 8) + '…' + RIGHT([ref], 4) AS [ref], [rule], [status], [content] FROM marts.document_text ORDER BY [ref]`,
);
```

Output:

```
marts.documents joined to marts.document_text:
┌─────────┬───────────────┬────────────┬────────────────────────────────┐
│ (index) │ id            │ status     │ content                        │
├─────────┼───────────────┼────────────┼────────────────────────────────┤
│ 0       │ 'invoice.txt' │ 'computed' │ 'Invoice 1042: 3 solar panels' │
│ 1       │ 'scan.bin'    │ 'empty'    │ null                           │
└─────────┴───────────────┴────────────┴────────────────────────────────┘
_warehouse._elt_files:
┌─────────┬────────────┬─────────────────────┬─────┬───────────┐
│ (index) │ scope      │ name                │ n   │ bytes     │
├─────────┼────────────┼─────────────────────┼─────┼───────────┤
│ 0       │ '3d078b59' │ '108c2c561ebe….bin' │ '0' │ '4194304' │
│ 1       │ '3d078b59' │ '108c2c561ebe….bin' │ '1' │ '4194304' │
│ 2       │ '3d078b59' │ '108c2c561ebe….bin' │ '2' │ '1048576' │
│ 3       │ '3d078b59' │ '28114f471383….txt' │ '0' │ '28'      │
└─────────┴────────────┴─────────────────────┴─────┴───────────┘
marts.document_text after a run on a new host:
┌─────────┬─────────────────┬───────────────┬────────────┬────────────────────────────────┐
│ (index) │ ref             │ rule          │ status     │ content                        │
├─────────┼─────────────────┼───────────────┼────────────┼────────────────────────────────┤
│ 0       │ '3d078b59….bin' │ 'unsupported' │ 'empty'    │ null                           │
│ 1       │ '3d078b59….txt' │ 'text-v2'     │ 'computed' │ 'Invoice 1042: 3 solar panels' │
└─────────┴─────────────────┴───────────────┴────────────┴────────────────────────────────┘
```

## Why it works

`destination.files()` is a `SqlServerFiles`, a subclass of `DatabaseFiles` of elt. A save writes the chunks of the file under a pending name, and renames them to the SHA-256 of the bytes and the extension when the scope has no file of that name. The 9 MiB `scan.bin` is three chunks: two of 4 MiB and one of 1 MiB. Each statement commits on its own, before the commit of the row that names the file.

`DocumentText` asks the storage for each ref. `open(ref)` writes a temporary copy, named as the stored file, into a folder of its own, and the dispose after the parse removes the folder. `identityFor` of the parser gets the name of the ref, so it sees `.bin` and `.txt` with no read of the bytes: `scan.bin` is `empty` with the rule `unsupported`.

The second host has the same declarations and a new parser. Its refresh finds that the rule of the `.txt` file changed, and reads the file again from `_warehouse._elt_files`.

## Things to know

- **Readers do not see the files.** `_warehouse._elt_files` is not in `marts`. A reader joins `marts.document_text.ref` to the ref column.
- **Names compare by their bytes.** `[scope]` and `[name]` are `COLLATE Latin1_General_BIN2` ([ADR 0015](../adr/0015-the-file-storage-compares-the-names-of-its-files-by-their-bytes.md)). A join of a ref column to `ref` uses the collation of the database, so on a collation that ignores case, add `COLLATE Latin1_General_BIN2` when two refs can differ only in case.
- **Each call has a session of its own.** A save, a reconcile, an `open` and a `head` each log in once. A parser whose `identityFor` reads `head` logs in once for each file at each refresh.
- **The reconcile keeps the files of the history.** A file stays while a row of the target, of its history or of the hidden target of a reload names it.
