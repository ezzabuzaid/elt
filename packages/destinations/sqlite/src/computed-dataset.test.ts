import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtempDisposable,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  DocumentParser,
  DocumentText,
  Pipeline,
  PipelineError,
  Source,
  type SourceWatchOptions,
  Stream,
} from '@workspace/elt';

import {
  ComputedDataset,
  SQLiteDestination,
  SQLiteSyncHistory,
  View,
} from './index.ts';

// Rows that name stored files by ref, loaded into raw_files and read through
// files; rows can change between runs. Its notes come from a second store,
// which fails every read while notesGone is set, as an app's missing store
// does. A watch sees every stream change at its start, and again as each
// promise of changes resolves.
class Files extends Source {
  readonly identity = 'files';
  rows: readonly { readonly id: string; readonly ref: string }[] = [];
  notesGone = false;
  changes: readonly Promise<void>[] = [];
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
  readonly notes = new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      description: 'A note.',
      properties: { id: { type: 'string', description: 'Note id.' } },
      required: ['id'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
  });
  protected readonly catalog = new Catalog([this.files, this.notes]);

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
    for (const change of this.changes) {
      await change;
      yield streams;
    }
  }

  protected override async *extract(configuration: CopyConfiguration) {
    if (configuration.stream.name === 'notes') {
      if (this.notesGone) throw new Error('the notes store is gone');
      return;
    }
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
  // Files whose read waits until their promise settles.
  readonly holding = new Map<string, Promise<void>>();
  handles = true;

  async parse(path: string): Promise<string | null> {
    this.parsed.push(basename(path));
    await this.holding.get(basename(path));
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
        steps: [
          new Copy(source.files, target),
          new Copy(source.notes, destination.table('raw_notes')),
        ],
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

test('a computed dataset reads a view declared before it: the text of each file the view names, and none once the view stops naming it', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-computed-'),
  );
  const store = join(scratch.path, 'files');
  await mkdir(store);
  await writeFile(join(store, 'a.txt'), 'invoice 123');
  await writeFile(join(store, 'b.txt'), 'receipt');
  await writeFile(join(store, 'scan.pdf'), 'not text');
  const source = new Files();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const target = destination.table('raw_files').withReaderView('files');
  const named = new View({
    into: destination,
    name: 'text_files',
    description: 'The rows that name a text file.',
    columns: { id: 'Row id.', ref: 'The stored file.' },
    sql: "SELECT id, ref FROM files WHERE ref LIKE '%.txt'",
  });
  const parser = new TextParser('text-v1');
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
      named,
      new ComputedDataset({
        into: destination,
        name: 'file_text',
        description: 'The text of each file a text row names.',
        from: [named],
        compute: new DocumentText({
          parser: () => parser,
          files: store,
          column: 'ref',
        }),
      }),
    ],
  });
  source.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'b.txt' },
    { id: '3', ref: 'scan.pdf' },
  ];

  await pipeline.run();
  const first = shell(destination.path, text).rows;
  source.rows = [{ id: '1', ref: 'a.txt' }];
  await pipeline.run();

  assert.deepEqual(first, [
    { ref: 'a.txt', status: 'computed', content: 'invoice 123', error: null },
    { ref: 'b.txt', status: 'computed', content: 'receipt', error: null },
  ]);
  assert.deepEqual(shell(destination.path, text).rows, [
    { ref: 'a.txt', status: 'computed', content: 'invoice 123', error: null },
  ]);
  assert.deepEqual(parser.parsed.toSorted(), ['a.txt', 'b.txt']);
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

test('a file that is slow to read holds only its own place: the text of the files read after it lands while it is still being read', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-computed-'),
  );
  const files = await filesImport(scratch.path);
  const names = Array.from({ length: 40 }, (_, index) => `f${index}.txt`);
  for (const name of ['slow.txt', ...names])
    await files.file(name, `text of ${name}`);
  files.source.rows = ['slow.txt', ...names].map((ref, index) => ({
    id: String(index),
    ref,
  }));
  const released = Promise.withResolvers<void>();
  files.parser().holding.set('slow.txt', released.promise);

  const running = files.pipeline.run();
  let landed: unknown[] = [];
  for (let tries = 0; landed.length < names.length; tries++) {
    if (tries > 1000)
      assert.fail(
        `only ${landed.length} of ${names.length} files landed while slow.txt was read`,
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
    landed = files.read("SELECT ref FROM file_text WHERE status = 'computed'");
  }
  const whileHeld = files.read(
    "SELECT ref FROM file_text WHERE ref = 'slow.txt'",
  );
  released.resolve();
  await running;

  assert.deepEqual(whileHeld, []);
  assert.deepEqual(
    files.read("SELECT ref, status FROM file_text WHERE ref = 'slow.txt'"),
    [{ ref: 'slow.txt', status: 'computed' }],
  );
});

test('a run whose other copy failed still stores the text of the files its loaded rows name, and then rejects with that copy’s failure', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-computed-'),
  );
  const files = await filesImport(scratch.path);
  await files.file('a.txt', 'invoice 123');
  files.source.rows = [{ id: '1', ref: 'a.txt' }];
  files.source.notesGone = true;

  const error = await files.pipeline.run().then(
    () => assert.fail('the run reported no failure'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.deepEqual(
    error.errors.map(({ message }: Error) => message),
    ['the notes store is gone'],
  );
  assert.deepEqual(files.read(text), [
    { ref: 'a.txt', status: 'computed', content: 'invoice 123', error: null },
  ]);
});

test('under a watch, a file that is slow to read holds no pass back: the next pass loads while it is read, the file is read once, and the files that pass loaded get their text after it', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-computed-'),
  );
  const files = await filesImport(scratch.path);
  await files.file('slow.txt', 'contract');
  await files.file('b.txt', 'receipt');
  files.source.rows = [{ id: '1', ref: 'slow.txt' }];
  const changed = Promise.withResolvers<void>();
  files.source.changes = [changed.promise];
  const released = Promise.withResolvers<void>();
  files.parser().holding.set('slow.txt', released.promise);
  const controller = new AbortController();
  const watching = files.pipeline.watch({ signal: controller.signal });
  // A pass that waits on the held read never comes; the bound ends the wait.
  const pass = () =>
    Promise.race([
      watching.next(),
      sleep(5000, undefined, { ref: false }).then(() =>
        assert.fail('the pass waited on the held read'),
      ),
    ]);

  try {
    const first = await pass();
    for (let tries = 0; !files.parser().parsed.includes('slow.txt'); tries++) {
      if (tries > 500) assert.fail('slow.txt was never read');
      await sleep(10);
    }
    files.source.rows = [
      { id: '1', ref: 'slow.txt' },
      { id: '2', ref: 'b.txt' },
    ];
    changed.resolve();
    const second = await pass();
    const whileHeld = files.read(text);
    released.resolve();
    for (
      let tries = 0;
      files.read("SELECT ref FROM file_text WHERE ref = 'b.txt'").length === 0;
      tries++
    ) {
      if (tries > 500) assert.fail('b.txt never got its text');
      await sleep(10);
    }

    assert.equal(first.done, false);
    assert.equal(second.done, false);
    assert.deepEqual(whileHeld, []);
    assert.deepEqual(files.parser().parsed.toSorted(), ['b.txt', 'slow.txt']);
    assert.deepEqual(files.read(text), [
      { ref: 'b.txt', status: 'computed', content: 'receipt', error: null },
      { ref: 'slow.txt', status: 'computed', content: 'contract', error: null },
    ]);
  } finally {
    released.resolve();
    controller.abort();
    await watching.return(undefined);
  }
});
