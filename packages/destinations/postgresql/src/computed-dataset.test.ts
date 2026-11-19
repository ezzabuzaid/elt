import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import { Latch } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { waitFor } from '@zukhruf/testing/async';
import { Postgres } from '@zukhruf/testing/postgres';
import { Vector } from '@zukhruf/vectors';
import { fromSql } from '@zukhruf/vectors/sqlite';
import postgres from 'postgres';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  DocumentParser,
  DocumentText,
  type LoadedRow,
  Pipeline,
  PipelineError,
  Rule,
  type RuleResult,
  type RuleValues,
  Source,
  Stream,
} from '@eltjs/elt';

import {
  ComputedDataset,
  PostgresDestination,
  PostgresSyncHistory,
  View,
} from './index.ts';

const databases = new Postgres({ environment: process.env });

// Rows that name stored files by ref, loaded into raw.raw_files and read
// through marts.files; rows can change between runs. Its notes fail every
// read while notesGone is set, as an app's missing store does.
class Files extends Source {
  readonly identity = 'files';
  rows: readonly { readonly id: string; readonly ref: string }[] = [];
  notesGone = false;
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

  // No test watches: each runs the pipeline itself.
  override changeSignals() {
    return [];
  }

  protected override async open() {
    return new AsyncDisposableStack();
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
  // Files whose read waits until their latch opens.
  readonly holding = new Map<string, Latch>();
  handles = true;

  async parse(path: string): Promise<string | null> {
    this.parsed.push(basename(path));
    await this.holding.get(basename(path))?.wait();
    if (this.failing.has(basename(path)))
      throw new Error(`${basename(path)} is damaged`);
    const text = await readFile(path, 'utf8');
    return text.trim() === '' ? null : text;
  }

  override async identityFor(): Promise<string | null> {
    return this.handles ? this.identity : null;
  }
}

const text =
  'SELECT ref, status, content, error FROM marts.file_text ORDER BY ref';

async function filesImport(url: string, directory: string) {
  const store = join(directory, 'files');
  await mkdir(store);
  const source = new Files();
  const raw = new PostgresDestination({ url, schema: 'raw' });
  const target = raw.table('raw_files').withReaderView('marts', 'files');
  let parser = new TextParser('text-v1');
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: [
      new Connection({
        name: 'files',
        source,
        destination: raw,
        steps: [
          new Copy(source.files, target),
          new Copy(source.notes, raw.table('raw_notes')),
        ],
      }),
    ],
    derived: [
      new ComputedDataset({
        into: new PostgresDestination({ url, schema: 'marts' }),
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
    file: (name: string, content: string) =>
      writeFile(join(store, name), content),
  };
}

const client = (url: string, clients: AsyncDisposableStack) =>
  clients.adopt(postgres(url, { max: 1, onnotice: () => {} }), (sql) =>
    sql.end(),
  );

test('a computed dataset stores the text of each file its input rows name, once for each file, and readers find it in the catalog', async () => {
  await using database = await databases.database();
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const files = await filesImport(url, scratch.path);
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

  assert.deepEqual(
    {
      rows: [...(await sql.unsafe(text))],
      parsed: files.parser().parsed.toSorted(),
      catalog: (
        await sql`
          SELECT name FROM marts.catalog
          WHERE name LIKE '%file_text%' ORDER BY name`
      ).map(({ name }) => name),
    },
    {
      rows: [
        {
          ref: 'a.txt',
          status: 'computed',
          content: 'invoice 123',
          error: null,
        },
        { ref: 'b.txt', status: 'computed', content: 'receipt', error: null },
        { ref: 'photo.txt', status: 'empty', content: null, error: null },
      ],
      parsed: ['a.txt', 'b.txt', 'photo.txt'],
      catalog: [
        'file_text',
        'file_text.content',
        'file_text.error',
        'file_text.input_hash',
        'file_text.ref',
        'file_text.rule',
        'file_text.status',
      ],
    },
  );
});

test('a computed dataset reads a view declared before it: the text of each file the view names, and none once the view stops naming it', async () => {
  await using database = await databases.database();
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const store = join(scratch.path, 'files');
  await mkdir(store);
  await writeFile(join(store, 'a.txt'), 'invoice 123');
  await writeFile(join(store, 'b.txt'), 'receipt');
  await writeFile(join(store, 'scan.pdf'), 'not text');
  const source = new Files();
  const raw = new PostgresDestination({ url, schema: 'raw' });
  const marts = new PostgresDestination({ url, schema: 'marts' });
  const target = raw.table('raw_files').withReaderView('marts', 'files');
  const named = new View({
    into: marts,
    name: 'text_files',
    description: 'The rows that name a text file.',
    columns: { id: 'Row id.', ref: 'The stored file.' },
    sql: "SELECT id, ref FROM files WHERE ref LIKE '%.txt'",
  });
  const parser = new TextParser('text-v1');
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: [
      new Connection({
        name: 'files',
        source,
        destination: raw,
        steps: [new Copy(source.files, target)],
      }),
    ],
    derived: [
      named,
      new ComputedDataset({
        into: marts,
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
  const first = [...(await sql.unsafe(text))];
  source.rows = [{ id: '1', ref: 'a.txt' }];
  await pipeline.run();

  assert.deepEqual(
    {
      first,
      second: [...(await sql.unsafe(text))],
      parsed: parser.parsed.toSorted(),
    },
    {
      first: [
        {
          ref: 'a.txt',
          status: 'computed',
          content: 'invoice 123',
          error: null,
        },
        { ref: 'b.txt', status: 'computed', content: 'receipt', error: null },
      ],
      second: [
        {
          ref: 'a.txt',
          status: 'computed',
          content: 'invoice 123',
          error: null,
        },
      ],
      parsed: ['a.txt', 'b.txt'],
    },
  );
});

test('the next run reads only the files that are new or that another parser would read otherwise, and drops the text of a file no row names', async () => {
  await using database = await databases.database();
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const files = await filesImport(url, scratch.path);
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

  assert.deepEqual(
    {
      second,
      third: files.parser().parsed.toSorted(),
      rows: [
        ...(await sql`SELECT ref, rule FROM marts.file_text ORDER BY ref`),
      ],
    },
    {
      second: ['a.txt', 'b.txt', 'c.txt'],
      third: ['a.txt', 'c.txt'],
      rows: [
        { ref: 'a.txt', rule: 'text-v2' },
        { ref: 'c.txt', rule: 'text-v2' },
      ],
    },
  );
});

test('a file the parser fails on is stored failed with why, the run still succeeds, and the next run reads it again', async () => {
  await using database = await databases.database();
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const files = await filesImport(url, scratch.path);
  await files.file('a.txt', 'invoice 123');
  await files.file('bad.txt', 'contract');
  files.source.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'bad.txt' },
  ];
  files.parser().failing.add('bad.txt');

  await files.pipeline.run();
  const failed = [...(await sql.unsafe(text))];
  files.parser().failing.clear();
  await files.pipeline.run();

  assert.deepEqual(
    { failed, retried: [...(await sql.unsafe(text))] },
    {
      failed: [
        {
          ref: 'a.txt',
          status: 'computed',
          content: 'invoice 123',
          error: null,
        },
        {
          ref: 'bad.txt',
          status: 'failed',
          content: null,
          error: 'bad.txt is damaged',
        },
      ],
      retried: [
        {
          ref: 'a.txt',
          status: 'computed',
          content: 'invoice 123',
          error: null,
        },
        {
          ref: 'bad.txt',
          status: 'computed',
          content: 'contract',
          error: null,
        },
      ],
    },
  );
});

test('a format the parser stops handling keeps the text read before, and a file it never read is stored empty as unsupported', async () => {
  await using database = await databases.database();
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const files = await filesImport(url, scratch.path);
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
    {
      rows: [
        ...(await sql`SELECT ref, status, rule, content FROM marts.file_text ORDER BY ref`),
      ],
      parsed: files.parser().parsed,
    },
    {
      rows: [
        {
          ref: 'a.txt',
          status: 'computed',
          rule: 'text-v1',
          content: 'invoice 123',
        },
        { ref: 'b.txt', status: 'empty', rule: 'unsupported', content: null },
      ],
      parsed: ['a.txt'],
    },
  );
});

test('a file that is slow to read holds only its own place: the text of the files read after it lands while it is still being read', async (t) => {
  await using database = await databases.database();
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const files = await filesImport(url, scratch.path);
  const names = Array.from({ length: 40 }, (_, index) => `f${index}.txt`);
  for (const name of ['slow.txt', ...names])
    await files.file(name, `text of ${name}`);
  files.source.rows = ['slow.txt', ...names].map((ref, index) => ({
    id: String(index),
    ref,
  }));
  const released = new Latch();
  files.parser().holding.set('slow.txt', released);

  const running = files.pipeline.run();
  await waitFor(
    async () => {
      const [landed] = await sql`
        SELECT count(*)::int AS n FROM marts.file_text WHERE status = 'computed'`;
      assert.ok(
        (landed?.n ?? 0) >= names.length,
        `only ${landed?.n} of ${names.length} files landed while slow.txt was read`,
      );
    },
    { signal: t.signal },
  );
  const whileHeld = [
    ...(await sql`SELECT ref FROM marts.file_text WHERE ref = 'slow.txt'`),
  ];
  released.open();
  await running;

  assert.deepEqual(
    {
      whileHeld,
      after: [
        ...(await sql`SELECT ref, status FROM marts.file_text WHERE ref = 'slow.txt'`),
      ],
    },
    { whileHeld: [], after: [{ ref: 'slow.txt', status: 'computed' }] },
  );
});

test('while a file is slow to read, marts.derived_status says that the dataset refreshes and how many inputs are pending, and once the refresh ends that it is current, with each status counted', async (t) => {
  await using database = await databases.database();
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const files = await filesImport(url, scratch.path);
  const names = Array.from({ length: 8 }, (_, index) => `f${index}.txt`);
  for (const name of ['slow.txt', ...names])
    await files.file(name, `text of ${name}`);
  files.source.rows = ['slow.txt', ...names].map((ref, index) => ({
    id: String(index),
    ref,
  }));
  const released = new Latch();
  files.parser().holding.set('slow.txt', released);
  const status = () => sql`
    SELECT kind, state, inputs::int, computed::int, failed::int, pending::int,
      as_of IS NOT NULL AS dated
    FROM marts.derived_status WHERE dataset = 'marts.file_text'`;

  const running = files.pipeline.run();
  const whileHeld = await waitFor(
    async () => {
      const [row] = await status();
      assert.equal(row?.pending, 1);
      return { ...row };
    },
    { signal: t.signal },
  );
  released.open();
  await running;

  assert.deepEqual(
    { whileHeld, after: [...(await status())] },
    {
      whileHeld: {
        kind: 'computed',
        state: 'refreshing',
        inputs: names.length + 1,
        computed: 0,
        failed: 0,
        pending: 1,
        dated: false,
      },
      after: [
        {
          kind: 'computed',
          state: 'current',
          inputs: names.length + 1,
          computed: names.length + 1,
          failed: 0,
          pending: 0,
          dated: true,
        },
      ],
    },
  );
});

test('a parser that fails on every file leaves the dataset current in marts.derived_status, with each failure counted', async () => {
  await using database = await databases.database();
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const files = await filesImport(url, scratch.path);
  await files.file('a.txt', 'invoice');
  await files.file('b.txt', 'receipt');
  files.source.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'b.txt' },
  ];
  files.parser().failing.add('a.txt');
  files.parser().failing.add('b.txt');

  await files.pipeline.run();

  assert.deepEqual(
    [
      ...(await sql`
        SELECT state, error, inputs::int, computed::int, failed::int, pending::int
        FROM marts.derived_status WHERE dataset = 'marts.file_text'`),
    ],
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
  await using database = await databases.database();
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const files = await filesImport(url, scratch.path);
  await files.file('a.txt', 'invoice 123');
  files.source.rows = [{ id: '1', ref: 'a.txt' }];
  files.source.notesGone = true;

  const error = await files.pipeline.run().then(
    () => assert.fail('the run reported no failure'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.deepEqual(
    {
      errors: error.errors.map(({ message }: Error) => message),
      rows: [...(await sql.unsafe(text))],
    },
    {
      errors: ['the notes store is gone'],
      rows: [
        {
          ref: 'a.txt',
          status: 'computed',
          content: 'invoice 123',
          error: null,
        },
      ],
    },
  );
});

test('the view of a computed dataset, read as of a position, shows the rows it had there after a later refresh changed one', async () => {
  await using database = await databases.database();
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const url = database.connectionString;
  const files = await filesImport(url, scratch.path);
  const marts = new PostgresDestination({ url, schema: 'marts' });
  await files.file('a.txt', 'first draft');
  files.source.rows = [{ id: '1', ref: 'a.txt' }];
  await files.pipeline.run();
  const positions = await marts.positions();
  const before = Array.isArray(positions) ? positions.at(-1) : undefined;
  files.replaceParser(new TextParser('text-v2'));
  await files.file('a.txt', 'final');
  await files.pipeline.run();

  const then = await marts.reading(before);
  if ('expired' in then) assert.fail(then.expired);
  await using _then = then;
  const now = await marts.reading();
  if ('expired' in now) assert.fail(now.expired);
  await using _now = now;
  assert.deepEqual(
    {
      then: [...(await then.sql`SELECT ref, content FROM marts.file_text`)],
      now: [...(await now.sql`SELECT ref, content FROM marts.file_text`)],
    },
    {
      then: [{ ref: 'a.txt', content: 'first draft' }],
      now: [{ ref: 'a.txt', content: 'final' }],
    },
  );
});

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

test('an integer column keeps each value as a bigint, and a vector column keeps as bytea the bytes that fromSql of @zukhruf/vectors/sqlite reads back', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const source = new Files();
  const raw = new PostgresDestination({ url, schema: 'raw' });
  const target = raw.table('raw_files').withReaderView('marts', 'files');
  const measure = new Measure();
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: [
      new Connection({
        name: 'files',
        source,
        destination: raw,
        steps: [new Copy(source.files, target)],
      }),
    ],
    derived: [
      new ComputedDataset({
        into: new PostgresDestination({ url, schema: 'marts' }),
        name: 'measures',
        description: 'The size and vector of each file a row names.',
        from: [target],
        compute: measure,
      }),
    ],
  });
  source.rows = [
    { id: '1', ref: 'a.txt' },
    { id: '2', ref: 'b.txt' },
  ];
  measure.answers.set('a.txt', {
    size: Number.MAX_SAFE_INTEGER,
    vector: Vector.from([0.5, -1, 2]),
  });

  await pipeline.run();

  assert.deepEqual(
    {
      rows: (
        await sql<
          {
            ref: string;
            status: string;
            size: string | null;
            vector: Buffer | null;
          }[]
        >`SELECT ref, status, size, vector FROM marts.measures ORDER BY ref`
      ).map(({ vector, ...row }) => ({
        ...row,
        vector: vector === null ? null : [...fromSql(Vector, vector).values],
      })),
      declared: [
        ...(await sql`
          SELECT attname AS name, format_type(atttypid, atttypmod) AS type
          FROM pg_attribute
          WHERE attrelid = 'marts.raw_measures'::regclass
            AND attname IN ('size', 'vector')
          ORDER BY attname`),
      ],
    },
    {
      rows: [
        {
          ref: 'a.txt',
          status: 'computed',
          size: String(Number.MAX_SAFE_INTEGER),
          vector: [0.5, -1, 2],
        },
        { ref: 'b.txt', status: 'computed', size: null, vector: null },
      ],
      declared: [
        { name: 'size', type: 'bigint' },
        { name: 'vector', type: 'bytea' },
      ],
    },
  );
});
