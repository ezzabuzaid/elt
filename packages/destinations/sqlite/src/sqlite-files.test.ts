import assert from 'node:assert/strict';
import { hash, randomBytes } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { open } from '@zukhruf/sqlite-open';

import {
  Catalog,
  Connection,
  Copy,
  type DocumentFile,
  DocumentParser,
  DocumentText,
  Pipeline,
  Source,
  type SourceMessage,
  StoredFileMissingError,
  Stream,
} from '@eltjs/elt';

import {
  ComputedDataset,
  SQLiteDestination,
  SQLiteSyncHistory,
} from './index.ts';

// More than two chunks of 4 MiB, so a file spans three chunks.
const large = 9 * 1024 * 1024 + 5;

const documents = new Stream({
  name: 'documents',
  jsonSchema: {
    type: 'object',
    description: 'A document with a file.',
    properties: { id: { type: 'string', description: 'Document id.' } },
    required: ['id'],
  },
  primaryKey: ['id'],
  supportedSyncModes: ['full_refresh'],
  supportsFileTransfer: true,
});

// Rows that name a ref as text, with no file.
const links = new Stream({
  name: 'links',
  jsonSchema: {
    type: 'object',
    description: 'A row that names a stored file by its ref.',
    properties: {
      id: { type: 'string', description: 'Row id.' },
      ref: { type: 'string', description: 'The ref.' },
    },
    required: ['id', 'ref'],
  },
  primaryKey: ['id'],
  supportedSyncModes: ['full_refresh'],
});

// Gives the messages that a test sets for each stream.
class Documents extends Source {
  readonly identity = 'documents';
  protected readonly catalog = new Catalog([documents, links]);
  messages: Record<string, readonly SourceMessage[]> = {};

  override coverage() {
    return { description: 'test', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  // No test watches: each runs the pipeline itself.
  override changeSignals() {
    return [];
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *extract({ stream }: { stream: Stream }) {
    yield* this.messages[stream.name] ?? [];
  }
}

// Gives the extension of the path it parses and the SHA-256 of its bytes,
// and records each path and each head that identityFor read.
class HashParser extends DocumentParser {
  readonly paths: string[] = [];
  readonly heads: Uint8Array[] = [];
  readonly #head: number | undefined;

  constructor(identity: string, head?: number) {
    super(identity);
    this.#head = head;
  }

  async parse(path: string): Promise<string> {
    this.paths.push(path);
    return `${extname(path)} ${hash('sha256', await readFile(path))}`;
  }

  override async identityFor(file: DocumentFile): Promise<string> {
    if (this.#head !== undefined) this.heads.push(await file.head(this.#head));
    return this.identity;
  }
}

// A copy of documents that stores each file in the SQLite file, and a
// computed dataset of the text of each stored file, read through the same
// storage. The clock is the test's, so a test can outwait the retention.
function documentsImport(
  path: string,
  parser: HashParser,
  source: Documents,
  options: {
    mode?: 'append' | 'overwrite';
    retention?: Temporal.Duration;
    now?: () => number;
  } = {},
) {
  const destination = new SQLiteDestination({
    path,
    ...(options.retention === undefined
      ? {}
      : { retention: options.retention }),
  });
  const target = destination.table('documents', (c) => [
    c.text('id'),
    c.text('ref').from(documents.file.store(destination.files())),
  ]);
  const linked = destination.table('links');
  const now = options.now;
  return {
    destination,
    pipeline: new Pipeline({
      clock:
        now === undefined
          ? globalThis
          : { Date: { now }, performance, setTimeout, clearTimeout },
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'documents',
          source,
          destination,
          steps: [
            new Copy(documents, target, {
              syncMode: 'full_refresh',
              destinationSyncMode: options.mode ?? 'overwrite',
            }),
            new Copy(links, linked),
          ],
        }),
      ],
      derived: [
        new ComputedDataset({
          into: destination,
          name: 'document_text',
          description: 'The text of each stored document.',
          from: [target],
          compute: new DocumentText({
            parser: () => parser,
            files: destination.files(),
            column: 'ref',
          }),
        }),
        new ComputedDataset({
          into: destination,
          name: 'link_text',
          description: 'The text of each file a link names.',
          from: [linked],
          compute: new DocumentText({
            parser: () => parser,
            files: destination.files(),
            column: 'ref',
          }),
        }),
      ],
    }),
  };
}

const read = (path: string, sql: string) => {
  using database = open(path, { readOnly: true });
  return database
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
};

const joined =
  'SELECT d.id, t.status, t.content, t.error FROM documents d JOIN document_text t ON t.ref = d.ref ORDER BY d.id';

test('a copy stores each file in the SQLite file, an empty one too, and the text of each stored file is computed from a temporary copy that keeps the extension and the bytes of the source and is gone after the run', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-db-files-');
  const big = randomBytes(large);
  await writeFile(join(scratch.path, 'big.bin'), big);
  await writeFile(join(scratch.path, 'note.txt'), 'note');
  await writeFile(join(scratch.path, 'empty.txt'), '');
  const source = new Documents();
  source.messages = {
    documents: [
      {
        stream: 'documents',
        data: { id: 'empty' },
        file: join(scratch.path, 'empty.txt'),
      },
      {
        stream: 'documents',
        data: { id: 'big' },
        file: join(scratch.path, 'big.bin'),
      },
      {
        stream: 'documents',
        data: { id: 'note' },
        file: join(scratch.path, 'note.txt'),
      },
    ],
  };
  const parser = new HashParser('hash-v1');
  const { pipeline } = documentsImport(
    join(scratch.path, 'data.sqlite'),
    parser,
    source,
  );

  await pipeline.run();

  assert.deepEqual(read(join(scratch.path, 'data.sqlite'), joined), [
    {
      id: 'big',
      status: 'computed',
      content: `.bin ${hash('sha256', big)}`,
      error: null,
    },
    {
      id: 'empty',
      status: 'computed',
      content: `.txt ${hash('sha256', '')}`,
      error: null,
    },
    {
      id: 'note',
      status: 'computed',
      content: `.txt ${hash('sha256', 'note')}`,
      error: null,
    },
  ]);
  assert.equal(parser.paths.length, 3);
  for (const path of parser.paths)
    await assert.rejects(stat(dirname(path)), { code: 'ENOENT' });
});

test('a second pipeline with no files folder and a parser of a new identity parses each file again from the SQLite file', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-db-files-');
  const sources = join(scratch.path, 'sources');
  await mkdir(sources);
  await writeFile(join(sources, 'note.txt'), 'note');
  const source = new Documents();
  source.messages = {
    documents: [
      {
        stream: 'documents',
        data: { id: 'note' },
        file: join(sources, 'note.txt'),
      },
    ],
  };
  const path = join(scratch.path, 'data.sqlite');
  await documentsImport(path, new HashParser('hash-v1'), source, {
    mode: 'append',
  }).pipeline.run();
  // The source file is gone too, and the append reads no row: only the
  // SQLite file holds the bytes.
  await rm(sources, { recursive: true });
  source.messages = {};
  const parser = new HashParser('hash-v2');

  await documentsImport(path, parser, source, {
    mode: 'append',
  }).pipeline.run();

  assert.deepEqual(
    {
      parsed: parser.paths.length,
      folder: (await readdir(scratch.path)).filter(
        (name) => !name.startsWith('data.sqlite'),
      ),
      rows: read(path, 'SELECT rule, status, content FROM document_text'),
    },
    {
      parsed: 1,
      folder: [],
      rows: [
        {
          rule: 'hash-v2',
          status: 'computed',
          content: `.txt ${hash('sha256', 'note')}`,
        },
      ],
    },
  );
});

test('the storage removes a file that no row names once the retention forgets the history rows that named it, and keeps it until then', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-db-files-');
  for (const name of ['a1.txt', 'a2.txt', 'b.txt'])
    await writeFile(join(scratch.path, name), name);
  const file = (id: string, name: string): SourceMessage => ({
    stream: 'documents',
    data: { id },
    file: join(scratch.path, name),
  });
  let now = Date.now();
  const source = new Documents();
  const { destination, pipeline } = documentsImport(
    join(scratch.path, 'data.sqlite'),
    new HashParser('hash-v1'),
    source,
    { retention: Temporal.Duration.from({ milliseconds: 20 }), now: () => now },
  );
  const refs = () =>
    Object.fromEntries(
      read(destination.path, 'SELECT id, ref FROM documents').map(
        ({ id, ref }) => [String(id), String(ref)],
      ),
    );
  const bytes = async (ref: string) => {
    try {
      await using opened = await destination.files().open(ref);
      return await readFile(opened.path, 'utf8');
    } catch (error) {
      if (error instanceof StoredFileMissingError) return 'missing';
      throw error;
    }
  };
  source.messages = { documents: [file('a', 'a1.txt'), file('b', 'b.txt')] };
  await pipeline.run();
  const first = refs();
  // The overwrite replaces a and deletes b; the history keeps both rows.
  source.messages = { documents: [file('a', 'a2.txt')] };
  await pipeline.run();
  const second = refs();
  const kept = [
    await bytes(String(first.a)),
    await bytes(String(first.b)),
    await bytes(String(second.a)),
  ];
  now += 60;

  // The next commit forgets the history rows older than the retention.
  await pipeline.run();

  assert.deepEqual(
    {
      kept,
      after: [
        await bytes(String(first.a)),
        await bytes(String(first.b)),
        await bytes(String(second.a)),
      ],
    },
    {
      kept: ['a1.txt', 'b.txt', 'a2.txt'],
      after: ['missing', 'missing', 'a2.txt'],
    },
  );
});

test('head reads the first bytes of a stored file across its chunks, and no more', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-db-files-');
  const big = randomBytes(large);
  await writeFile(join(scratch.path, 'big.bin'), big);
  const source = new Documents();
  source.messages = {
    documents: [
      {
        stream: 'documents',
        data: { id: 'big' },
        file: join(scratch.path, 'big.bin'),
      },
    ],
  };
  // Past the end of the first chunk.
  const length = 4 * 1024 * 1024 + 16;
  const parser = new HashParser('hash-v1', length);

  await documentsImport(
    join(scratch.path, 'data.sqlite'),
    parser,
    source,
  ).pipeline.run();

  assert.ok(parser.heads.length > 0);
  for (const head of parser.heads)
    assert.ok(Buffer.from(head).equals(big.subarray(0, length)));
});

test('a ref that the SQLite file does not hold fails only its row, with a message that says to reload the copy that stored it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-db-files-');
  await writeFile(join(scratch.path, 'note.txt'), 'note');
  const ref = `${'0'.repeat(64)}/gone.txt`;
  const source = new Documents();
  source.messages = {
    documents: [
      {
        stream: 'documents',
        data: { id: 'note' },
        file: join(scratch.path, 'note.txt'),
      },
    ],
    links: [{ stream: 'links', data: { id: 'gone', ref } }],
  };

  await documentsImport(
    join(scratch.path, 'data.sqlite'),
    new HashParser('hash-v1'),
    source,
  ).pipeline.run();

  assert.deepEqual(
    read(
      join(scratch.path, 'data.sqlite'),
      'SELECT ref, status, error FROM link_text',
    ),
    [
      {
        ref,
        status: 'failed',
        error: `Table _elt_files has no stored file ${ref}. Reload the copy that stored it to store the file again.`,
      },
    ],
  );
});
