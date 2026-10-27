import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  DocumentParser,
  DocumentText,
  Pipeline,
  Source,
  type SourceWatchOptions,
  Stream,
} from '@workspace/elt';

import {
  ComputedDataset,
  SQLiteDestination,
  SQLiteSyncHistory,
} from './index.ts';

// Rows that name stored files by ref, loaded into raw_files and read through
// files; rows can change between runs.
class Files extends Source {
  readonly identity = 'files';
  rows: readonly { readonly id: string; readonly ref: string }[] = [];
  readonly files = new Stream({
    name: 'files',
    jsonSchema: {
      type: 'object',
      description: 'A row naming a stored file.',
      properties: {
        id: { type: 'string', description: 'Row id.' },
        ref: { type: 'string', description: 'The stored file.' },
      },
      required: ['id', 'ref'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
  });
  protected readonly catalog = new Catalog([this.files]);

  override coverage() {
    return { description: 'test', selection: {} };
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
    for (const row of this.rows)
      yield { stream: configuration.stream.name, data: row };
  }
}

// A parser of UTF-8 text files: a real DocumentParser, which records each
// file it parses, fails on the files named in failing, and handles no file
// while handles is false.
class TextParser extends DocumentParser {
  readonly parsed: string[] = [];
  readonly failing = new Set<string>();
  handles = true;

  async parse(path: string): Promise<string | null> {
    this.parsed.push(basename(path));
    if (this.failing.has(basename(path)))
      throw new Error(`${basename(path)} is damaged`);
    const text = await readFile(path, 'utf8');
    return text.trim() === '' ? null : text;
  }

  override async identityFor(): Promise<string | null> {
    return this.handles ? this.identity : null;
  }
}

async function filesImport(directory: string) {
  const store = join(directory, 'files');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(store);
  const source = new Files();
  const destination = new SQLiteDestination({
    path: join(directory, 'data.sqlite'),
  });
  const target = destination.table('raw_files').withReaderView('files');
  let parser = new TextParser('text-v1');
  const pipeline = new Pipeline({
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'files',
        source,
        destination,
        steps: [new Copy(source.files, target)],
      }),
    ],
    derived: [
      new ComputedDataset({
        into: destination,
        name: 'file_text',
        description: 'The text of each file a row names.',
        from: [target],
        compute: new DocumentText({
          parser: () => parser,
          files: store,
          column: 'ref',
        }),
      }),
    ],
  });
  return {
    source,
    pipeline,
    parser: () => parser,
    replaceParser: (next: TextParser) => {
      parser = next;
    },
    file: (name: string, text: string) => writeFile(join(store, name), text),
    read: (sql: string) => shell(destination.path, sql).rows,
  };
}

// The sqlite3 shell agents read with.
function shell(database: string, sql: string) {
  const { stdout, stderr } = spawnSync(
    '/usr/bin/sqlite3',
    ['-readonly', '-json', database, sql],
    { encoding: 'utf8' },
  );
  return { rows: JSON.parse(stdout || '[]'), stderr };
}

const text = 'SELECT ref, status, content, error FROM file_text ORDER BY ref';

test('a computed dataset stores the text of each file its input rows name, once for each file, and readers find it in the catalog', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-computed-'),
  );
  const files = await filesImport(scratch.path);
  await files.file('a.txt', 'invoice 123');
  await files.file('b.txt', 'receipt');
  await files.file('photo.txt', ' ');
  files.source.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'a.txt' },
    { id: '3', ref: 'b.txt' },
    { id: '4', ref: 'photo.txt' },
  ];

  await files.pipeline.run();

  assert.deepEqual(files.read(text), [
    { ref: 'a.txt', status: 'computed', content: 'invoice 123', error: null },
    { ref: 'b.txt', status: 'computed', content: 'receipt', error: null },
    { ref: 'photo.txt', status: 'empty', content: null, error: null },
  ]);
  assert.deepEqual(files.parser().parsed.toSorted(), [
    'a.txt',
    'b.txt',
    'photo.txt',
  ]);
  assert.deepEqual(
    files
      .read(
        "SELECT name FROM catalog WHERE name LIKE 'file_text%' ORDER BY name",
      )
      .map(({ name }: { name: string }) => name),
    [
      'file_text',
      'file_text.content',
      'file_text.error',
      'file_text.input_hash',
      'file_text.ref',
      'file_text.rule',
      'file_text.status',
    ],
  );
});

test('the next run reads only the files that are new or that another parser would read otherwise, and drops the text of a file no row names', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-computed-'),
  );
  const files = await filesImport(scratch.path);
  await files.file('a.txt', 'invoice 123');
  await files.file('b.txt', 'receipt');
  await files.file('c.txt', 'contract');
  files.source.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'b.txt' },
  ];
  await files.pipeline.run();
  files.source.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '3', ref: 'c.txt' },
  ];

  await files.pipeline.run();
  const second = [...files.parser().parsed];
  files.replaceParser(new TextParser('text-v2'));
  await files.pipeline.run();

  assert.deepEqual(second, ['a.txt', 'b.txt', 'c.txt']);
  assert.deepEqual(files.parser().parsed.toSorted(), ['a.txt', 'c.txt']);
  assert.deepEqual(files.read('SELECT ref, rule FROM file_text ORDER BY ref'), [
    { ref: 'a.txt', rule: 'text-v2' },
    { ref: 'c.txt', rule: 'text-v2' },
  ]);
});

test('a file the parser fails on is stored failed with why, the run still succeeds, and the next run reads it again', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-computed-'),
  );
  const files = await filesImport(scratch.path);
  await files.file('a.txt', 'invoice 123');
  await files.file('bad.txt', 'contract');
  files.source.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'bad.txt' },
  ];
  files.parser().failing.add('bad.txt');

  await files.pipeline.run();
  const failed = files.read(text);
  files.parser().failing.clear();
  await files.pipeline.run();

  assert.deepEqual(failed, [
    { ref: 'a.txt', status: 'computed', content: 'invoice 123', error: null },
    {
      ref: 'bad.txt',
      status: 'failed',
      content: null,
      error: 'bad.txt is damaged',
    },
  ]);
  assert.deepEqual(files.read(text), [
    { ref: 'a.txt', status: 'computed', content: 'invoice 123', error: null },
    { ref: 'bad.txt', status: 'computed', content: 'contract', error: null },
  ]);
});

test('a format the parser stops handling keeps the text read before, and a file it never read is stored empty as unsupported', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-computed-'),
  );
  const files = await filesImport(scratch.path);
  await files.file('a.txt', 'invoice 123');
  await files.file('b.txt', 'receipt');
  files.source.rows = [{ id: '1', ref: 'a.txt' }];
  await files.pipeline.run();
  files.parser().handles = false;
  files.source.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'b.txt' },
  ];

  await files.pipeline.run();

  assert.deepEqual(
    files.read('SELECT ref, status, rule, content FROM file_text ORDER BY ref'),
    [
      {
        ref: 'a.txt',
        status: 'computed',
        rule: 'text-v1',
        content: 'invoice 123',
      },
      { ref: 'b.txt', status: 'empty', rule: 'unsupported', content: null },
    ],
  );
  assert.deepEqual(files.parser().parsed, ['a.txt']);
});
