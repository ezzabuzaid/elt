import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Latch, untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import { open } from '@zukhruf/sqlite-open';
import { waitFor } from '@zukhruf/testing/async';
import { Vector } from '@zukhruf/vectors';
import { fromSql } from '@zukhruf/vectors/sqlite';

import {
  Connection,
  Copy,
  DerivedDatasetError,
  type DocumentFile,
  DocumentParser,
  DocumentText,
  type FailureType,
  FileStorage,
  Gauge,
  IterableSource,
  type LoadedRow,
  LocalFiles,
  Pipeline,
  PipelineError,
  Rule,
  type RuleColumns,
  type RuleResult,
  type RuleValues,
} from '@eltjs/elt';

import {
  ComputedDataset,
  SQLiteDestination,
  SQLiteSyncHistory,
  View,
} from './index.ts';

// The version of an upstream, which the test moves to make a change.
class Version extends Gauge<number> {
  current = 0;

  protected async read(): Promise<number> {
    return this.current;
  }
}

// The change signal of both streams: a watch sees every stream change at its
// start, and again each time the test moves the version of its upstream.
const paced = (version: Version) => ({
  gauge: () => version,
  interval: 10,
  timeout: 10,
});

// Rows that name stored files by ref, loaded into raw_files and read through
// files; rows can change between runs, and every read of them fails while
// filesGone is set. Its notes come from a second store, which fails every
// read while notesGone is set, as an app's missing store does.
class FilesHost {
  rows: readonly { readonly id: string; readonly ref: string }[] = [];
  filesGone = false;
  notesGone = false;
  readonly version = new Version();
  readonly source = new IterableSource({
    identity: 'files',
    streams: {
      files: {
        description: 'The rows that the test sets.',
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
        snapshot: () => {
          if (this.filesGone) throw new Error('the files store is gone');
          return this.rows;
        },
        changeSignal: paced(this.version),
      },
      notes: {
        description: 'No note.',
        jsonSchema: {
          type: 'object',
          description: 'A note.',
          properties: { id: { type: 'string', description: 'Note id.' } },
          required: ['id'],
        },
        primaryKey: ['id'],
        snapshot: () => {
          if (this.notesGone) throw new Error('the notes store is gone');
          return [];
        },
        changeSignal: paced(this.version),
      },
    },
  });
}

// A parser of UTF-8 text files: a real DocumentParser, which records each
// file it parses, fails on the files named in failing, and handles no file
// while handles is false.
class TextParser extends DocumentParser {
  readonly parsed: string[] = [];
  readonly failing = new Set<string>();
  // Files whose read waits until their latch opens, or until the read stops,
  // as a parser that honors its signal does.
  readonly holding = new Map<string, Latch>();
  handles = true;

  async parse(path: string, signal?: AbortSignal): Promise<string | null> {
    this.parsed.push(basename(path));
    const held = this.holding.get(basename(path));
    if (held !== undefined) await untilAborted(held.wait(), signal);
    if (this.failing.has(basename(path)))
      throw new Error(`${basename(path)} is damaged`);
    const text = await readFile(path, 'utf8');
    return text.trim() === '' ? null : text;
  }

  override async identityFor(_file: DocumentFile): Promise<string | null> {
    return this.handles ? this.identity : null;
  }
}

async function filesImport(directory: string) {
  const store = join(directory, 'files');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(store);
  const host = new FilesHost();
  const destination = new SQLiteDestination({
    path: join(directory, 'data.sqlite'),
  });
  const target = destination.table('files');
  let parser = new TextParser('text-v1');
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'files',
        source: host.source,
        destination,
        steps: [
          new Copy(host.source.streams.files, target),
          new Copy(host.source.streams.notes, destination.table('notes')),
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
          files: new LocalFiles({ directory: store }),
          column: 'ref',
        }),
      }),
    ],
  });
  return {
    host,
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
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await filesImport(scratch.path);
  await files.file('a.txt', 'invoice 123');
  await files.file('b.txt', 'receipt');
  await files.file('photo.txt', ' ');
  files.host.rows = [
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
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const store = join(scratch.path, 'files');
  await mkdir(store);
  await writeFile(join(store, 'a.txt'), 'invoice 123');
  await writeFile(join(store, 'b.txt'), 'receipt');
  await writeFile(join(store, 'scan.pdf'), 'not text');
  const host = new FilesHost();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const target = destination.table('files');
  const named = new View({
    into: destination,
    name: 'text_files',
    description: 'The rows that name a text file.',
    columns: { id: 'Row id.', ref: 'The stored file.' },
    sql: "SELECT id, ref FROM files WHERE ref LIKE '%.txt'",
  });
  const parser = new TextParser('text-v1');
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'files',
        source: host.source,
        destination,
        steps: [new Copy(host.source.streams.files, target)],
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
          files: new LocalFiles({ directory: store }),
          column: 'ref',
        }),
      }),
    ],
  });
  host.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'b.txt' },
    { id: '3', ref: 'scan.pdf' },
  ];

  await pipeline.run();
  const first = shell(destination.path, text).rows;
  host.rows = [{ id: '1', ref: 'a.txt' }];
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
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await filesImport(scratch.path);
  await files.file('a.txt', 'invoice 123');
  await files.file('b.txt', 'receipt');
  await files.file('c.txt', 'contract');
  files.host.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'b.txt' },
  ];
  await files.pipeline.run();
  files.host.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '3', ref: 'c.txt' },
  ];

  await files.pipeline.run();
  const second = files.parser().parsed.toSorted();
  files.replaceParser(new TextParser('text-v2'));
  await files.pipeline.run();

  assert.deepEqual(second, ['a.txt', 'b.txt', 'c.txt']);
  assert.deepEqual(files.parser().parsed.toSorted(), ['a.txt', 'c.txt']);
  assert.deepEqual(files.read('SELECT ref, rule FROM file_text ORDER BY ref'), [
    { ref: 'a.txt', rule: 'text-v2' },
    { ref: 'c.txt', rule: 'text-v2' },
  ]);
});

test('a file that rows name and the files folder does not have fails its row with how to store it again, both on a read by a new parser and on a first read, and the run still succeeds', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await filesImport(scratch.path);
  await files.file('a.txt', 'invoice 123');
  await files.file('b.txt', 'receipt');
  files.host.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'b.txt' },
  ];
  await files.pipeline.run();
  await rm(join(scratch.path, 'files', 'a.txt'));
  files.host.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'b.txt' },
    { id: '3', ref: 'c.txt' },
  ];
  files.replaceParser(new TextParser('text-v2'));

  await files.pipeline.run();

  const missing = (ref: string) =>
    `The files folder ${join(scratch.path, 'files')} has no file ${ref}. Reload the copy that stored it to store the file again.`;
  assert.deepEqual(
    files.read(
      'SELECT ref, rule, status, content, error FROM file_text ORDER BY ref',
    ),
    [
      {
        ref: 'a.txt',
        rule: 'text-v2',
        status: 'failed',
        content: null,
        error: missing('a.txt'),
      },
      {
        ref: 'b.txt',
        rule: 'text-v2',
        status: 'computed',
        content: 'receipt',
        error: null,
      },
      {
        ref: 'c.txt',
        rule: 'text-v2',
        status: 'failed',
        content: null,
        error: missing('c.txt'),
      },
    ],
  );
});

test('under a watch, a file that a commit removes with its rows while the file is read leaves no row once the refresh after that commit ends', async (t) => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await filesImport(scratch.path);
  await files.file('a.txt', 'invoice 123');
  await files.file('b.txt', 'receipt');
  files.host.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'b.txt' },
  ];
  const released = new Latch();
  files.parser().holding.set('b.txt', released);
  const controller = new AbortController();
  const watching = files.pipeline.watch({ signal: controller.signal });
  const status = `SELECT state, inputs, computed, failed, pending FROM derived_status WHERE dataset = 'file_text'`;

  try {
    await watching.next();
    await waitFor(
      () => {
        assert.ok(
          files.parser().parsed.includes('b.txt'),
          'b.txt was never read',
        );
      },
      { signal: t.signal, interval: 10 },
    );
    await rm(join(scratch.path, 'files', 'b.txt'));
    files.host.rows = [{ id: '1', ref: 'a.txt' }];
    files.host.version.current += 1;
    await watching.next();
    released.open();
    // The refresh that read b.txt counts two inputs; the one after the
    // commit that removed b.txt counts one.
    const after = await waitFor(
      () => {
        const [row] = files.read(status);
        assert.deepEqual(row, {
          state: 'current',
          inputs: 1,
          computed: 1,
          failed: 0,
          pending: 0,
        });
        return row;
      },
      { signal: t.signal, interval: 10 },
    );

    assert.deepEqual(after, {
      state: 'current',
      inputs: 1,
      computed: 1,
      failed: 0,
      pending: 0,
    });
    assert.deepEqual(files.read(text), [
      { ref: 'a.txt', status: 'computed', content: 'invoice 123', error: null },
    ]);
  } finally {
    released.open();
    controller.abort();
    await watching.return(undefined);
  }
});

test('a file the parser fails on is stored failed with why, the run still succeeds, and the next run reads it again', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await filesImport(scratch.path);
  await files.file('a.txt', 'invoice 123');
  await files.file('bad.txt', 'contract');
  files.host.rows = [
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
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await filesImport(scratch.path);
  await files.file('a.txt', 'invoice 123');
  await files.file('b.txt', 'receipt');
  files.host.rows = [{ id: '1', ref: 'a.txt' }];
  await files.pipeline.run();
  files.parser().handles = false;
  files.host.rows = [
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

// A parser that identifies each file by its name and its first bytes, as a
// parser of formats that name themselves does, and records what it saw.
class HeadParser extends TextParser {
  readonly identified: {
    readonly name: string;
    readonly heads: readonly string[];
  }[] = [];

  override async identityFor(file: DocumentFile): Promise<string | null> {
    const heads = [];
    for (const length of [3, 7])
      heads.push(new TextDecoder().decode(await file.head(length)));
    this.identified.push({ name: file.name, heads });
    return this.identity;
  }
}

test('a parser identifies a stored file by its file name, with its extension, and by the first bytes that it asks the storage for', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await filesImport(scratch.path);
  await mkdir(join(scratch.path, 'files', 'scans'));
  await files.file('scans/a.txt', 'invoice 123');
  await files.file('scans/b.md', 'note');
  files.host.rows = [
    { id: '1', ref: 'scans/a.txt' },
    { id: '2', ref: 'scans/b.md' },
  ];
  const parser = new HeadParser('text-v1');
  files.replaceParser(parser);

  await files.pipeline.run();

  assert.deepEqual(
    // Each refresh of the run asks again, with the same file.
    Object.fromEntries(
      parser.identified.map(({ name, heads }) => [name, heads]),
    ),
    { 'a.txt': ['inv', 'invoice'], 'b.md': ['not', 'note'] },
  );
  assert.deepEqual(files.read(text), [
    {
      ref: 'scans/a.txt',
      status: 'computed',
      content: 'invoice 123',
      error: null,
    },
    { ref: 'scans/b.md', status: 'computed', content: 'note', error: null },
  ]);
});

test('a parser that identifies a file by its first bytes fails only the row of a file that the storage does not hold, with how to store it again, and the run still succeeds', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await filesImport(scratch.path);
  await files.file('a.txt', 'invoice 123');
  await files.file('b.txt', 'receipt');
  files.host.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'b.txt' },
  ];
  files.replaceParser(new HeadParser('text-v1'));
  await files.pipeline.run();
  await rm(join(scratch.path, 'files', 'a.txt'));
  files.host.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'b.txt' },
    { id: '3', ref: 'c.txt' },
  ];
  files.replaceParser(new HeadParser('text-v2'));

  await files.pipeline.run();

  const missing = (ref: string) =>
    `The files folder ${join(scratch.path, 'files')} has no file ${ref}. Reload the copy that stored it to store the file again.`;
  assert.deepEqual(files.read(text), [
    { ref: 'a.txt', status: 'failed', content: null, error: missing('a.txt') },
    { ref: 'b.txt', status: 'computed', content: 'receipt', error: null },
    { ref: 'c.txt', status: 'failed', content: null, error: missing('c.txt') },
  ]);
});

// A storage that keeps its files in a folder the rule may not read, as a
// database keeps them in its tables: open gives a temporary copy of the file
// that its dispose removes, as DatabaseFiles does, and head counts its reads.
// It stores nothing itself, because the rows of the test name files that it
// already holds.
class CopyingFiles extends FileStorage {
  override readonly identity = 'copying-files';
  override readonly reference = 'A file of the held folder.';
  heads = 0;
  // A ref whose open and head fail as a storage that cannot be reached fails,
  // each with its own message.
  unreachable: string | undefined;
  readonly #held: string;
  readonly #copies: string;

  constructor(held: string, copies: string) {
    super();
    this.#held = held;
    this.#copies = copies;
  }

  override async open(ref: string) {
    if (ref === this.unreachable)
      throw new Error('the held folder is unreachable');
    const path = join(this.#copies, `${crypto.randomUUID()}-${basename(ref)}`);
    await copyFile(join(this.#held, ref), path);
    return { path, [Symbol.asyncDispose]: () => rm(path) };
  }

  override async head(ref: string, length: number) {
    if (ref === this.unreachable)
      throw new Error('the held folder is unreachable for a read of a head');
    this.heads += 1;
    return (await readFile(join(this.#held, ref))).subarray(0, length);
  }

  override async save(): Promise<string> {
    throw new Error('unexpected save');
  }

  override async flush(): Promise<void> {
    throw new Error('unexpected flush');
  }

  override async retain(): Promise<void> {
    throw new Error('unexpected retain');
  }

  override failureType(): FailureType {
    throw new Error('unexpected failure');
  }
}

// The rows of Files, loaded into raw_files, and the text of each file that
// they name, which parser reads through a CopyingFiles over held.
async function copyingImport(directory: string, parser: TextParser) {
  const held = join(directory, 'held');
  const copies = join(directory, 'copies');
  await mkdir(held);
  await mkdir(copies);
  const storage = new CopyingFiles(held, copies);
  const host = new FilesHost();
  const destination = new SQLiteDestination({
    path: join(directory, 'data.sqlite'),
  });
  const target = destination.table('files');
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'files',
        source: host.source,
        destination,
        steps: [new Copy(host.source.streams.files, target)],
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
          files: storage,
          column: 'ref',
        }),
      }),
    ],
  });
  return {
    storage,
    host,
    pipeline,
    parser,
    copies,
    file: (name: string, content: string) =>
      writeFile(join(held, name), content),
    read: (sql: string) => shell(destination.path, sql).rows,
  };
}

test('the rule reads each file through its storage: the parser gets a path that the storage opened, the storage removes it after the parse, and a parser that identifies by name reads no bytes', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await copyingImport(scratch.path, new TextParser('text-v1'));
  await files.file('a.txt', 'invoice 123');
  await files.file('b.txt', 'receipt');
  files.host.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'b.txt' },
  ];

  await files.pipeline.run();

  assert.deepEqual(files.read(text), [
    { ref: 'a.txt', status: 'computed', content: 'invoice 123', error: null },
    { ref: 'b.txt', status: 'computed', content: 'receipt', error: null },
  ]);
  assert.deepEqual(
    // Each copy is named by a UUID, a hyphen and the file name.
    files.parser.parsed.map((name) => name.slice(37)).toSorted(),
    ['a.txt', 'b.txt'],
  );
  assert.deepEqual(await readdir(files.copies), []);
  assert.equal(files.storage.heads, 0);
});

test('a storage that fails to open a file for a reason other than not holding it fails the refresh, as a failure of the storage and not of the row of the file', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await copyingImport(scratch.path, new TextParser('text-v1'));
  await files.file('a.txt', 'invoice 123');
  files.host.rows = [{ id: '1', ref: 'a.txt' }];
  files.storage.unreachable = 'a.txt';

  const error = await files.pipeline.run().then(
    () => assert.fail('the run reported no failure'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof DerivedDatasetError, String(error));
  assert.deepEqual(
    { message: error.message, rows: files.read(text) },
    {
      message:
        'Derived dataset file_text failed: the held folder is unreachable',
      rows: [],
    },
  );
});

test('a storage that fails to read the first bytes of a file for a reason other than not holding it fails the refresh, when a parser identifies the file by those bytes', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await copyingImport(scratch.path, new HeadParser('text-v1'));
  await files.file('a.txt', 'invoice 123');
  files.host.rows = [{ id: '1', ref: 'a.txt' }];
  files.storage.unreachable = 'a.txt';

  const error = await files.pipeline.run().then(
    () => assert.fail('the run reported no failure'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof DerivedDatasetError, String(error));
  assert.deepEqual(
    { message: error.message, rows: files.read(text) },
    {
      message:
        'Derived dataset file_text failed: the held folder is unreachable for a read of a head',
      rows: [],
    },
  );
});

test('a refresh that its watch stops while a file is parsed stores no row for that file and stays refreshing with no error, as a stop is not the file’s failure', async (t) => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await filesImport(scratch.path);
  await files.file('a.txt', 'invoice 123');
  files.host.rows = [{ id: '1', ref: 'a.txt' }];
  const released = new Latch();
  files.parser().holding.set('a.txt', released);
  const status = `SELECT state, error, pending FROM derived_status WHERE dataset = 'file_text'`;
  const controller = new AbortController();
  const watching = files.pipeline.watch({ signal: controller.signal });

  let held;
  try {
    await watching.next();
    held = await waitFor(
      () => {
        assert.deepEqual(files.parser().parsed, ['a.txt']);
        return files.read(status);
      },
      { signal: t.signal, interval: 10 },
    );
  } finally {
    controller.abort();
    await watching.return(undefined);
    released.open();
  }

  assert.deepEqual(
    {
      held,
      stopped: files.read(
        `SELECT state, error FROM derived_status WHERE dataset = 'file_text'`,
      ),
      rows: files.read(text),
    },
    {
      held: [{ state: 'refreshing', error: null, pending: 1 }],
      stopped: [{ state: 'refreshing', error: null }],
      rows: [],
    },
  );
});

test('a file that is slow to read holds only its own place: the text of the files read after it lands while it is still being read', async (t) => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await filesImport(scratch.path);
  const names = Array.from({ length: 40 }, (_, index) => `f${index}.txt`);
  for (const name of ['slow.txt', ...names])
    await files.file(name, `text of ${name}`);
  files.host.rows = ['slow.txt', ...names].map((ref, index) => ({
    id: String(index),
    ref,
  }));
  const released = new Latch();
  files.parser().holding.set('slow.txt', released);

  const running = files.pipeline.run();
  await waitFor(
    () => {
      const landed = files.read(
        "SELECT ref FROM file_text WHERE status = 'computed'",
      );
      assert.ok(
        landed.length >= names.length,
        `only ${landed.length} of ${names.length} files landed while slow.txt was read`,
      );
    },
    { signal: t.signal, interval: 10 },
  );
  const whileHeld = files.read(
    "SELECT ref FROM file_text WHERE ref = 'slow.txt'",
  );
  released.open();
  await running;

  assert.deepEqual(whileHeld, []);
  assert.deepEqual(
    files.read("SELECT ref, status FROM file_text WHERE ref = 'slow.txt'"),
    [{ ref: 'slow.txt', status: 'computed' }],
  );
});

test('while a file is slow to read, derived_status says that the dataset refreshes and how many inputs are pending, and once the refresh ends that it is current, with each status counted', async (t) => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await filesImport(scratch.path);
  const names = Array.from({ length: 8 }, (_, index) => `f${index}.txt`);
  for (const name of ['slow.txt', ...names])
    await files.file(name, `text of ${name}`);
  files.host.rows = ['slow.txt', ...names].map((ref, index) => ({
    id: String(index),
    ref,
  }));
  const released = new Latch();
  files.parser().holding.set('slow.txt', released);
  const status = `SELECT kind, state, inputs, computed, failed, pending, as_of IS NOT NULL AS dated FROM derived_status WHERE dataset = 'file_text'`;

  const running = files.pipeline.run();
  const whileHeld = await waitFor(
    () => {
      const [row] = files.read(status);
      assert.equal(row?.pending, 1);
      return row;
    },
    { signal: t.signal, interval: 10 },
  );
  released.open();
  await running;

  assert.deepEqual(
    { whileHeld, after: files.read(status) },
    {
      whileHeld: {
        kind: 'computed',
        state: 'refreshing',
        inputs: names.length + 1,
        computed: 0,
        failed: 0,
        pending: 1,
        dated: 0,
      },
      after: [
        {
          kind: 'computed',
          state: 'current',
          inputs: names.length + 1,
          computed: names.length + 1,
          failed: 0,
          pending: 0,
          dated: 1,
        },
      ],
    },
  );
});

test('a parser that fails on every file leaves the dataset current in derived_status, with each failure counted', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await filesImport(scratch.path);
  await files.file('a.txt', 'invoice');
  await files.file('b.txt', 'receipt');
  files.host.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'b.txt' },
  ];
  files.parser().failing.add('a.txt');
  files.parser().failing.add('b.txt');

  await files.pipeline.run();

  assert.deepEqual(
    files.read(
      `SELECT state, error, inputs, computed, failed, pending FROM derived_status WHERE dataset = 'file_text'`,
    ),
    [
      {
        state: 'current',
        error: null,
        inputs: 2,
        computed: 0,
        failed: 2,
        pending: 0,
      },
    ],
  );
});

test('a run whose other copy failed still stores the text of the files its loaded rows name, and then rejects with that copy’s failure', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await filesImport(scratch.path);
  await files.file('a.txt', 'invoice 123');
  files.host.rows = [{ id: '1', ref: 'a.txt' }];
  files.host.notesGone = true;

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

test('under a watch, a file that is slow to read holds no pass back: the next pass loads while it is read, the file is read once, and the files that pass loaded get their text after it', async (t) => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await filesImport(scratch.path);
  await files.file('slow.txt', 'contract');
  await files.file('b.txt', 'receipt');
  files.host.rows = [{ id: '1', ref: 'slow.txt' }];
  const released = new Latch();
  files.parser().holding.set('slow.txt', released);
  const controller = new AbortController();
  const watching = files.pipeline.watch({ signal: controller.signal });
  // A pass that waits on the held read never comes, and the test fails at its limit.
  const pass = () => untilAborted(watching.next(), t.signal);

  try {
    const first = await pass();
    await waitFor(
      () => {
        assert.ok(
          files.parser().parsed.includes('slow.txt'),
          'slow.txt was never read',
        );
      },
      { signal: t.signal, interval: 10 },
    );
    files.host.rows = [
      { id: '1', ref: 'slow.txt' },
      { id: '2', ref: 'b.txt' },
    ];
    files.host.version.current += 1;
    const second = await pass();
    const whileHeld = files.read(text);
    released.open();
    await waitFor(
      () => {
        assert.notEqual(
          files.read("SELECT ref FROM file_text WHERE ref = 'b.txt'").length,
          0,
          'b.txt never got its text',
        );
      },
      { signal: t.signal, interval: 10 },
    );

    assert.equal(first.done, false);
    assert.equal(second.done, false);
    assert.deepEqual(whileHeld, []);
    assert.deepEqual(files.parser().parsed.toSorted(), ['b.txt', 'slow.txt']);
    assert.deepEqual(files.read(text), [
      { ref: 'b.txt', status: 'computed', content: 'receipt', error: null },
      { ref: 'slow.txt', status: 'computed', content: 'contract', error: null },
    ]);
  } finally {
    released.open();
    controller.abort();
    await watching.return(undefined);
  }
});

test('derived_status gives as_of as the time the last refresh began to read, which refreshing_since shows while that refresh runs', async (t) => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const files = await filesImport(scratch.path);
  await files.file('a.txt', 'invoice');
  files.host.rows = [{ id: '1', ref: 'a.txt' }];
  files.parser().failing.add('a.txt');
  await files.pipeline.run();
  // A failed file is read again only by the refresh after the passes, the
  // last refresh of the run; it waits on released, and it runs at least
  // 20 ms, so the time it began and the time it ended differ.
  files.parser().failing.delete('a.txt');
  const released = new Latch();
  files.parser().holding.set('a.txt', released);
  const status = `SELECT state, as_of, refreshed_at, refreshing_since FROM derived_status WHERE dataset = 'file_text'`;

  const running = files.pipeline.run();
  const [whileHeld] = await waitFor(
    () => {
      assert.equal(files.parser().parsed.length, 2);
      return files.read(status);
    },
    { signal: t.signal, interval: 10 },
  );
  await sleep(20);
  released.open();
  await running;
  const [after] = files.read(status);

  assert.equal(whileHeld.state, 'refreshing');
  assert.equal(typeof whileHeld.refreshing_since, 'string');
  assert.deepEqual(
    { state: after.state, as_of: after.as_of, since: after.refreshing_since },
    { state: 'current', as_of: whileHeld.refreshing_since, since: null },
  );
  assert.ok(
    after.refreshed_at > after.as_of,
    `refreshed_at ${after.refreshed_at} is not after as_of ${after.as_of}`,
  );
});

// A stand-in for a model behind the Rule port, which a host calls for each
// file: each call answers after 50 ms, so a call that fails at once ends
// before the calls beside it; a call that names a ref in refused fails, and
// one that names a ref in holding waits until its refresh stops, then
// rejects with the stop, as an AI SDK call that honors its AbortSignal does.
// A real model needs the network and a key, and its answers vary, so a test
// cannot hold its calls or know what they return.
const answered = {
  answer: { type: 'text', description: 'What the model answered.' },
} as const;

class Model extends Rule<string, typeof answered> {
  override readonly key = { name: 'ref', description: 'The file.' };
  override readonly output = answered;
  override readonly batch = 1;
  override readonly concurrency: number;
  // The inputs of each call, in the order the calls began.
  readonly calls: string[][] = [];
  readonly refused = new Set<string>();
  readonly holding = new Set<string>();

  constructor(concurrency: number) {
    super();
    this.concurrency = concurrency;
  }

  override read(row: LoadedRow) {
    return typeof row.ref === 'string'
      ? { key: row.ref, input: row.ref }
      : null;
  }

  override async identity() {
    return 'model-1';
  }

  override async compute(inputs: readonly string[], signal?: AbortSignal) {
    this.calls.push([...inputs]);
    if (inputs.some((ref) => this.refused.has(ref)))
      throw new Error(`the model refused ${inputs.join(', ')}`);
    if (inputs.some((ref) => this.holding.has(ref)))
      await new Promise<never>((_, reject) =>
        signal?.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    await sleep(50);
    return inputs.map((ref) => ({ value: { answer: ref.toUpperCase() } }));
  }
}

// The rows of Files, loaded into raw_files and read through files, and the
// computed dataset answers, which model makes from each file a row names.
function modelImport(directory: string, model: Rule<string, RuleColumns>) {
  const host = new FilesHost();
  const destination = new SQLiteDestination({
    path: join(directory, 'data.sqlite'),
  });
  const target = destination.table('files');
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'files',
        source: host.source,
        destination,
        steps: [new Copy(host.source.streams.files, target)],
      }),
    ],
    derived: [
      new ComputedDataset({
        into: destination,
        name: 'answers',
        description: 'What the model answered for each file a row names.',
        from: [target],
        compute: model,
      }),
    ],
  });
  return {
    host,
    pipeline,
    path: destination.path,
    read: (sql: string) => shell(destination.path, sql).rows,
  };
}

test('a rule call that fails stops the calls after it in its refresh: the call beside it lands its row, the refresh after the pass tries the failed file again beside the next one, the last file never reaches the model, and the run rejects with the failure', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const model = new Model(2);
  const answers = modelImport(scratch.path, model);
  answers.host.rows = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map(
    (ref, index) => ({ id: String(index), ref }),
  );
  model.refused.add('a.txt');

  const error = await answers.pipeline.run().then(
    () => assert.fail('the run reported no failure'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof DerivedDatasetError, String(error));
  assert.deepEqual(
    {
      message: error.message,
      calls: model.calls,
      rows: answers.read(
        'SELECT ref, status, answer FROM answers ORDER BY ref',
      ),
    },
    {
      message: 'Derived dataset answers failed: the model refused a.txt',
      // The refresh for the commit, then the refresh after the pass.
      calls: [['a.txt'], ['b.txt'], ['a.txt'], ['c.txt']],
      rows: [
        { ref: 'b.txt', status: 'computed', answer: 'B.TXT' },
        { ref: 'c.txt', status: 'computed', answer: 'C.TXT' },
      ],
    },
  );
});

test('a refresh that its watch stops while the model answers stays refreshing in derived_status, with no error, and the watch yields no dataset failure, as a stop is not the dataset’s failure', async (t) => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const model = new Model(1);
  const answers = modelImport(scratch.path, model);
  answers.host.rows = [{ id: '0', ref: 'a.txt' }];
  model.holding.add('a.txt');
  const status = `SELECT state, error, pending FROM derived_status WHERE dataset = 'answers'`;
  const controller = new AbortController();
  const watching = answers.pipeline.watch({ signal: controller.signal });
  const kinds: string[] = [];

  let held;
  try {
    const first = await watching.next();
    if (!first.done) kinds.push(first.value.kind);
    held = await waitFor(
      () => {
        assert.deepEqual(model.calls, [['a.txt']]);
        return answers.read(status);
      },
      { signal: t.signal, interval: 10 },
    );
  } finally {
    controller.abort();
    kinds.push(...(await Array.fromAsync(watching, ({ kind }) => kind)));
  }

  assert.deepEqual(
    { held, stopped: answers.read(status), kinds },
    {
      held: [{ state: 'refreshing', error: null, pending: 1 }],
      stopped: [{ state: 'refreshing', error: null, pending: 1 }],
      kinds: ['pass'],
    },
  );
});

test('a computed dataset whose rule cannot read an input row fails in derived_status with the error, and the run rejects with that dataset failure', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  // A rule with a bug in how it reads a loaded row.
  class Misread extends Model {
    override read(): never {
      throw new Error('the rule cannot read the row');
    }
  }
  const answers = modelImport(scratch.path, new Misread(1));
  answers.host.rows = [{ id: '0', ref: 'a.txt' }];

  const error = await answers.pipeline.run().then(
    () => assert.fail('the run reported no failure'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof DerivedDatasetError, String(error));
  assert.deepEqual(
    {
      message: error.message,
      status: answers.read(
        `SELECT state, error FROM derived_status WHERE dataset = 'answers'`,
      ),
    },
    {
      message: 'Derived dataset answers failed: the rule cannot read the row',
      status: [{ state: 'failed', error: 'the rule cannot read the row' }],
    },
  );
});

test('a computed dataset whose input table a person dropped waits in derived_status, and keeps the rows it made', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const answers = modelImport(scratch.path, new Model(1));
  answers.host.rows = [{ id: '0', ref: 'a.txt' }];
  await answers.pipeline.run();
  // No operation of elt drops a loaded table: a person does it by hand, and
  // the copy cannot load it again while its store is gone.
  {
    using database = open(answers.path);
    database.exec('DROP TABLE raw_files');
  }
  answers.host.filesGone = true;

  await assert.rejects(answers.pipeline.run(), PipelineError);

  assert.deepEqual(
    {
      status: answers.read(
        `SELECT state, error FROM derived_status WHERE dataset = 'answers'`,
      ),
      rows: answers.read('SELECT ref, status, answer FROM answers'),
    },
    {
      status: [{ state: 'waiting', error: null }],
      rows: [{ ref: 'a.txt', status: 'computed', answer: 'A.TXT' }],
    },
  );
});

// A rule that only names its columns: the dataset checks them when it is
// constructed, before any input reaches compute.
class NamedColumns extends Rule<string, RuleColumns> {
  override readonly key = { name: 'ref', description: 'The input.' };
  override readonly output: RuleColumns;
  override readonly batch = 1;
  override readonly concurrency = 1;

  constructor(output: readonly string[]) {
    super();
    this.output = Object.fromEntries(
      output.map((name) => [name, { type: 'text', description: name }]),
    );
  }

  override read() {
    return null;
  }

  override async identity() {
    return null;
  }

  override async compute() {
    return [];
  }
}

void test.each(
  [
    ['status', 'an engine column'],
    ['Committed_In', 'a column the dataset writes itself, in another case'],
    ['REPLACED_IN', 'the column its history adds, in another case'],
    ['_ELT_ROW_HASH', 'the hash of the values of a row, in another case'],
    ['ref', 'the key column'],
  ] as const,
  ([column, owner]) =>
    test(`a rule output column named ${column}, ${owner}, is refused when the dataset is constructed, by name`, () => {
      assert.throws(
        () =>
          new ComputedDataset({
            into: new SQLiteDestination({ path: ':memory:' }),
            name: 'file_text',
            description: 'The text of each file a row names.',
            from: [],
            compute: new NamedColumns(['content', column]),
          }),
        new TypeError(
          `Computed dataset file_text cannot have the column ${column}: the dataset already has the column ${column.toLowerCase()}`,
        ),
      );
    }),
);

// A size and a vector of 3 dimensions for each file, as a model that measures
// files gives them; the test sets the answer for each ref.
const measured = {
  size: { type: 'integer', description: 'The size of the file.' },
  vector: {
    type: 'vector',
    dimensions: 3,
    description: 'The file as a vector.',
  },
} as const;

class Measure extends Rule<string, typeof measured> {
  override readonly key = { name: 'ref', description: 'The file.' };
  override readonly output = measured;
  override readonly batch = 10;
  override readonly concurrency = 1;
  readonly answers = new Map<string, RuleValues<typeof measured>>();

  override read(row: LoadedRow) {
    return typeof row.ref === 'string'
      ? { key: row.ref, input: row.ref }
      : null;
  }

  override async identity() {
    return 'measure-1';
  }

  override async compute(
    refs: readonly string[],
  ): Promise<readonly RuleResult<RuleValues<typeof measured>>[]> {
    return refs.map((ref) => ({ value: this.answers.get(ref) ?? {} }));
  }
}

function measuredRows(path: string) {
  using database = open(path, { readOnly: true });
  return database
    .prepare(
      'SELECT ref, status, error, size, typeof(size) AS stored, vector FROM answers ORDER BY ref',
    )
    .all()
    .map(({ ref, status, error, size, stored, vector }) => ({
      ref,
      status,
      error,
      size,
      stored,
      vector:
        vector instanceof Uint8Array
          ? [...fromSql(Vector, vector).values]
          : vector,
    }));
}

test('an integer column keeps each value as an INTEGER, and a vector column keeps the bytes that fromSql of @zukhruf/vectors/sqlite reads back', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const measure = new Measure();
  const answers = modelImport(scratch.path, measure);
  answers.host.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'b.txt' },
  ];
  measure.answers.set('a.txt', {
    size: Number.MAX_SAFE_INTEGER,
    vector: Vector.from([0.5, -1, 2]),
  });

  await answers.pipeline.run();

  assert.deepEqual(
    {
      rows: measuredRows(answers.path),
      declared: answers.read(
        "SELECT name, type FROM pragma_table_info('raw_answers') WHERE name IN ('size', 'vector') ORDER BY name",
      ),
    },
    {
      rows: [
        {
          ref: 'a.txt',
          status: 'computed',
          error: null,
          size: Number.MAX_SAFE_INTEGER,
          stored: 'integer',
          vector: [0.5, -1, 2],
        },
        {
          ref: 'b.txt',
          status: 'computed',
          error: null,
          size: null,
          stored: 'null',
          vector: null,
        },
      ],
      declared: [
        { name: 'size', type: 'INTEGER' },
        { name: 'vector', type: 'BLOB' },
      ],
    },
  );
});

test('a value that does not fit its column fails its row with why: an integer that is not safe names its column, a vector of other dimensions names both counts, and the other rows land', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const measure = new Measure();
  const answers = modelImport(scratch.path, measure);
  answers.host.rows = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map(
    (ref, index) => ({ id: String(index), ref }),
  );
  const fits = Vector.from([1, 2, 3]);
  measure.answers.set('a.txt', { size: 2 ** 53, vector: fits });
  measure.answers.set('b.txt', { size: 1.5, vector: fits });
  measure.answers.set('c.txt', { size: 7, vector: Vector.from([1, 2]) });
  measure.answers.set('d.txt', { size: 7, vector: fits });

  await answers.pipeline.run();

  assert.deepEqual(
    measuredRows(answers.path).map(({ ref, status, error, size }) => ({
      ref,
      status,
      error,
      size,
    })),
    [
      {
        ref: 'a.txt',
        status: 'failed',
        error:
          'The column size takes a safe integer, and the rule gave 9007199254740992.',
        size: null,
      },
      {
        ref: 'b.txt',
        status: 'failed',
        error: 'The column size takes a safe integer, and the rule gave 1.5.',
        size: null,
      },
      {
        ref: 'c.txt',
        status: 'failed',
        error:
          'The column vector takes a vector of 3 dimensions, and the rule gave one of 2.',
        size: null,
      },
      { ref: 'd.txt', status: 'computed', error: null, size: 7 },
    ],
  );
});

test('the value of each rule column has the type of its kind, so a rule cannot give a vector column a string or a text column a vector', () => {
  const values: RuleValues<{
    readonly text: { readonly type: 'text'; readonly description: string };
    readonly vector: typeof measured.vector;
  }>[] = [
    { text: 'a', vector: Vector.from([1, 2, 3]) },
    // @ts-expect-error -- a vector column takes a Vector
    { vector: 'a' },
    // @ts-expect-error -- a text column takes a string
    { text: Vector.from([1, 2, 3]) },
  ];

  assert.equal(values.length, 3);
});
