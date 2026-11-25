import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { test } from 'node:test';

import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  type Partition,
  Pipeline,
  PipelineError,
  type SavedEntries,
  Source,
  type SourceMessage,
  type StateMessage,
  Stream,
} from '@eltjs/elt';

import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from './index.ts';

const databases = new Postgres({ environment: process.env });

// Pages by URL, read incrementally; with body, a later shape of the same
// stream. With partitioned, each site is a partition.
const pages = ({ name = 'pages', body = false, partitioned = false } = {}) =>
  new Stream({
    name,
    jsonSchema: {
      type: 'object',
      description: 'A page.',
      properties: {
        site: { type: 'string', description: 'Site of the page.' },
        url: { type: 'string', description: 'URL of the page.' },
        ...(body
          ? { body: { type: 'string', description: 'Text of the page.' } }
          : {}),
      },
      required: ['site', 'url'],
    },
    primaryKey: ['site', 'url'],
    ...(partitioned ? { partitionKey: ['site'] } : {}),
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });

// Emits what the test scripts for each partition by its site, or for each
// stream by its name when the stream is not partitioned, and keeps the
// entries of spaces that each extract found when it started.
class Keyed extends Source {
  readonly identity = 'keyed';
  readonly streams: readonly Stream[];
  protected readonly catalog: Catalog;
  script: Record<string, readonly (SourceMessage | Error)[]> = {};
  sites = ['a', 'b'];
  spaces = ['crawl', 'diff'];
  found: Record<string, Record<string, Record<string, unknown>>> = {};

  constructor(...streams: Stream[]) {
    super();
    this.streams = streams;
    this.catalog = new Catalog(streams);
  }

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

  protected override partitions() {
    return this.sites.map((site) => ({ site }));
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    _state: unknown,
    partition: Partition | null,
    _context: AsyncDisposable,
    _signal: AbortSignal | undefined,
    entries: SavedEntries,
  ) {
    const name = String(partition?.site ?? configuration.stream.name);
    this.found[name] = Object.fromEntries(
      await Promise.all(
        this.spaces.map(async (space) => [
          space,
          Object.fromEntries(await entries.space(space)),
        ]),
      ),
    );
    for (const message of this.script[name] ?? []) {
      if (Error.isError(message)) throw message;
      yield message;
    }
  }
}

// A database of its own, its checkpoints, and a run of an incremental copy
// of each stream of source, whose id is the stream's name.
async function pagesDatabase() {
  const database = await databases.database();
  const url = database.connectionString;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const destination = new PostgresDestination({ url });
  const checkpoints = new PostgresCheckpointStore({ url });
  const run = (source: Keyed) =>
    new Pipeline({
      clock: globalThis,
      history: new PostgresSyncHistory({ url }),
      connections: [
        new Connection({
          name: 'pages',
          source,
          destination,
          checkpoints,
          steps: source.streams.map(
            (stream) =>
              new Copy(stream, destination.table(stream.name), {
                id: stream.name,
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
              }),
          ),
        }),
      ],
    }).run();
  const loaded = async () =>
    (await sql`SELECT site, url FROM marts.pages ORDER BY url`).map(
      ({ site, url }) => `${String(site)}${String(url)}`,
    );
  return {
    checkpoints,
    run,
    loaded,
    async [Symbol.asyncDispose]() {
      await sql.end();
      await database[Symbol.asyncDispose]();
    },
  };
}

const page = (url: string, site = 'a') => ({
  stream: 'pages',
  data: { site, url },
});
const state = (
  entries?: StateMessage['entries'],
  stream = 'pages',
): StateMessage => ({
  type: 'STATE',
  stream,
  state: {},
  ...(entries === undefined ? {} : { entries }),
});
const reset = { type: 'RESET' as const, stream: 'pages' };

// Whether a run failed with a TypeError of its copy whose message matches.
const failedWith = (message: RegExp) => (error: unknown) =>
  error instanceof PipelineError &&
  error.errors[0] instanceof TypeError &&
  message.test(error.errors[0].message);

test('a STATE whose entries are not a valid shape fails the copy before its records commit, and the next run reads the entries saved before it', async () => {
  await using database = await pagesDatabase();
  const { run, loaded } = database;
  const source = new Keyed(pages());
  source.script = {
    pages: [page('1'), state({ crawl: { put: [['1', 'seen']] } })],
  };
  await run(source);
  // JSON.parse gives shapes that the type of a STATE refuses, as a source
  // in JavaScript can send them.
  const invalid: [StateMessage, RegExp][] = [
    [state({ crawl: { put: [['2', 1]], remove: ['2'] } }), /both puts/],
    [state({ crawl: { put: [['2', new Date(0)]] } }), /losslessly JSON/],
    [state({ crawl: { put: [['2', undefined]] } }), /losslessly JSON/],
    [
      state({ crawl: { put: [['2', 'a\uD800']] } }),
      /entry 2 of space crawl has a lone surrogate/,
    ],
    [state({ crawl: { put: [['\uD800', 1]] } }), /key .*lone surrogate/],
    [state({ '\uD800': { put: [['2', 1]] } }), /space .*lone surrogate/],
    [state({ crawl: { put: [['2\0', 1]] } }), /key .*has U\+0000/],
    [state({ crawl: { remove: ['2\0'] } }), /key .*has U\+0000/],
    [state({ 'cr\0awl': { put: [['2', 1]] } }), /space .*has U\+0000/],
    [state({ crawl: { remove: '2' } }), /remove of space crawl/],
    [
      state(JSON.parse('{"crawl":{"put":[[2,1]]}}')),
      /key of space crawl .*must be a string/,
    ],
    [state(JSON.parse('{"crawl":{"put":[["2"]]}}')), /pair/],
    [
      state(JSON.parse('{"crawl":{"remove":[2]}}')),
      /key of space crawl .*must be a string/,
    ],
    [state(JSON.parse('{"crawl":{"put":{"2":1}}}')), /put of space crawl/],
    [state(JSON.parse('{"crawl":[]}')), /space crawl/],
    [state(JSON.parse('{"crawl":{"drop":["1"]}}')), /space crawl/],
    [state(JSON.parse('[]')), /entries/],
    [
      JSON.parse('{"type":"STATE","stream":"pages","state":{},"clear":[""]}'),
      /Only Source.read clears/,
    ],
  ];
  const failures: boolean[] = [];

  for (const [message, error] of invalid) {
    source.script = { pages: [page('2'), message] };
    failures.push(
      await run(source).then(
        () => false,
        (failure: unknown) => failedWith(error)(failure),
      ),
    );
  }
  source.script = { pages: [] };
  await run(source);

  assert.deepEqual(
    failures,
    invalid.map(() => true),
  );
  assert.deepEqual(source.found.pages, { crawl: { '1': 'seen' }, diff: {} });
  assert.deepEqual(await loaded(), ['a1']);
});

test('a run that fails after a STATE resumes from the entries that STATE saved, beside the records it committed', async () => {
  await using database = await pagesDatabase();
  const { run, loaded } = database;
  const source = new Keyed(pages());
  source.script = {
    pages: [
      page('1'),
      state({ crawl: { put: [['1', { due: 1 }]] } }),
      page('2'),
      new Error('gone'),
    ],
  };
  await assert.rejects(run(source), PipelineError);
  source.script = { pages: [] };

  await run(source);

  assert.deepEqual(
    { found: source.found.pages, loaded: await loaded() },
    { found: { crawl: { '1': { due: 1 } }, diff: {} }, loaded: ['a1'] },
  );
});

test('a resumed run reads exactly the entries that its STATEs put and did not remove since', async () => {
  await using database = await pagesDatabase();
  const { run } = database;
  const source = new Keyed(pages());
  source.script = {
    pages: [
      state({
        crawl: {
          put: [
            ['a', 1],
            ['b', 1],
            ['c', 1],
          ],
        },
      }),
      state({ crawl: { put: new Map([['a', 2]]), remove: ['b'] } }),
      state({ crawl: { put: [['d', [1, 'x']]], remove: ['missing'] } }),
    ],
  };
  await run(source);
  const first = source.found.pages;
  source.script = { pages: [state({ crawl: { remove: ['c'] } })] };
  await run(source);
  const second = source.found.pages;
  source.script = { pages: [] };

  await run(source);

  assert.deepEqual(
    { first, second, third: source.found.pages },
    {
      first: { crawl: {}, diff: {} },
      second: { crawl: { a: 2, c: 1, d: [1, 'x'] }, diff: {} },
      third: { crawl: { a: 2, d: [1, 'x'] }, diff: {} },
    },
  );
});

test('the entries of two spaces do not meet: a key put or removed in one keeps its value in the other', async () => {
  await using database = await pagesDatabase();
  const { run } = database;
  const source = new Keyed(pages());
  source.script = {
    pages: [
      state({ crawl: { put: [['x', 'crawled']] }, diff: { put: [['x', 7]] } }),
      state({ diff: { remove: ['x'] } }),
      state({ crawl: { put: [['y', 'crawled']] } }),
    ],
  };
  await run(source);
  source.script = { pages: [] };

  await run(source);

  assert.deepEqual(source.found.pages, {
    crawl: { x: 'crawled', y: 'crawled' },
    diff: {},
  });
});

test('a STATE with no entries keeps the entries saved before it', async () => {
  await using database = await pagesDatabase();
  const { run } = database;
  const source = new Keyed(pages());
  source.script = {
    pages: [state({ crawl: { put: [['x', 1]] } }), state()],
  };
  await run(source);
  source.script = { pages: [state(), state({})] };
  await run(source);
  source.script = { pages: [] };

  await run(source);

  assert.deepEqual(source.found.pages, { crawl: { x: 1 }, diff: {} });
});

test('two incremental copies of one connection keep their entries apart, and a reset of one leaves the entries of the other', async () => {
  await using database = await pagesDatabase();
  const { run, checkpoints } = database;
  const source = new Keyed(pages(), pages({ name: 'posts' }));
  source.script = {
    pages: [state({ crawl: { put: [['k', 'page']] } })],
    posts: [state({ crawl: { put: [['k', 'post']] } }, 'posts')],
  };
  await run(source);
  source.script = {};
  await run(source);
  const apart = { ...source.found };
  await checkpoints.reset('pages');

  await run(source);

  assert.deepEqual(
    { apart, afterReset: source.found },
    {
      apart: {
        pages: { crawl: { k: 'page' }, diff: {} },
        posts: { crawl: { k: 'post' }, diff: {} },
      },
      afterReset: {
        pages: { crawl: {}, diff: {} },
        posts: { crawl: { k: 'post' }, diff: {} },
      },
    },
  );
});

test('a whole-stream RESET forgets the entries saved before it: its next STATE keeps only its own', async () => {
  await using database = await pagesDatabase();
  const { run, loaded } = database;
  const source = new Keyed(pages());
  source.script = {
    pages: [
      page('1'),
      state({ crawl: { put: [['1', 1]] }, diff: { put: [['1', 1]] } }),
    ],
  };
  await run(source);
  source.script = {
    pages: [reset, page('2'), state({ crawl: { put: [['2', 1]] } })],
  };
  await run(source);
  source.script = { pages: [] };

  await run(source);

  assert.deepEqual(
    { found: source.found.pages, loaded: await loaded() },
    { found: { crawl: { '2': 1 }, diff: {} }, loaded: ['a2'] },
  );
});

test('a reset checkpoint starts the next run with no entries', async () => {
  await using database = await pagesDatabase();
  const { run, checkpoints } = database;
  const source = new Keyed(pages());
  source.script = {
    pages: [state({ crawl: { put: [['x', 1]] }, diff: { put: [['y', 1]] } })],
  };
  await run(source);
  await checkpoints.reset('pages');
  source.script = { pages: [] };

  await run(source);

  assert.deepEqual(source.found.pages, { crawl: {}, diff: {} });
});

test('a reload that starts over reads no entries, and its first STATE replaces the saved ones', async () => {
  await using database = await pagesDatabase();
  const { run, loaded } = database;
  const before = new Keyed(pages());
  before.script = {
    pages: [page('1'), state({ crawl: { put: [['1', 1]] } })],
  };
  await run(before);
  before.script = {
    pages: [
      reset,
      page('2'),
      state({ crawl: { put: [['2', 1]] } }),
      new Error('gone'),
    ],
  };
  await assert.rejects(run(before), PipelineError);
  // The reload's hidden target no longer fits the stream, so the reload
  // starts over.
  const reshaped = new Keyed(pages({ body: true }));
  reshaped.script = {
    pages: [page('3'), state({ crawl: { put: [['3', 1]] } })],
  };
  await run(reshaped);
  const reloaded = reshaped.found.pages;
  reshaped.script = { pages: [] };

  await run(reshaped);

  assert.deepEqual(
    { reloaded, resumed: reshaped.found.pages, loaded: await loaded() },
    {
      reloaded: { crawl: {}, diff: {} },
      resumed: { crawl: { '3': 1 }, diff: {} },
      loaded: ['a3'],
    },
  );
});

test('a reload that starts over and ends with no STATE leaves no entries', async () => {
  await using database = await pagesDatabase();
  const { run } = database;
  const before = new Keyed(pages());
  before.script = {
    pages: [page('1'), state({ crawl: { put: [['1', 1]] } })],
  };
  await run(before);
  before.script = {
    pages: [
      reset,
      page('2'),
      state({ crawl: { put: [['2', 1]] } }),
      new Error('gone'),
    ],
  };
  await assert.rejects(run(before), PipelineError);
  const reshaped = new Keyed(pages({ body: true }));
  reshaped.script = { pages: [page('3')] };
  await run(reshaped);
  reshaped.script = { pages: [] };

  await run(reshaped);

  assert.deepEqual(reshaped.found.pages, { crawl: {}, diff: {} });
});

test('the same key in two partitions keeps two entries', async () => {
  await using database = await pagesDatabase();
  const { run } = database;
  const source = new Keyed(pages({ partitioned: true }));
  source.script = {
    a: [page('1', 'a'), state({ crawl: { put: [['k', 'a']] } })],
    b: [page('1', 'b'), state({ crawl: { put: [['k', 'b']] } })],
  };
  await run(source);
  source.script = {};

  await run(source);

  assert.deepEqual(source.found, {
    a: { crawl: { k: 'a' }, diff: {} },
    b: { crawl: { k: 'b' }, diff: {} },
  });
});

test('a partition that the stream no longer lists has its entries cleared with its state', async () => {
  await using database = await pagesDatabase();
  const { run } = database;
  const source = new Keyed(pages({ partitioned: true }));
  source.script = {
    a: [state({ crawl: { put: [['k', 'a']] } })],
    b: [state({ crawl: { put: [['k', 'b']] }, diff: { put: [['k', 'b']] } })],
  };
  await run(source);
  source.sites = ['a'];
  source.script = { a: [state()] };
  await run(source);
  source.sites = ['a', 'b'];
  source.script = {};

  await run(source);

  assert.deepEqual(source.found, {
    a: { crawl: { k: 'a' }, diff: {} },
    b: { crawl: {}, diff: {} },
  });
});

test('a RESET of a partition clears only the entries of that partition', async () => {
  await using database = await pagesDatabase();
  const { run } = database;
  const source = new Keyed(pages({ partitioned: true }));
  source.script = {
    a: [state({ crawl: { put: [['x', 'a']] }, diff: { put: [['x', 'a']] } })],
    b: [state({ crawl: { put: [['x', 'b']] } })],
  };
  await run(source);
  source.script = {
    a: [reset, state({ crawl: { put: [['y', 'a']] } })],
  };
  await run(source);
  source.script = {};

  await run(source);

  assert.deepEqual(source.found, {
    a: { crawl: { y: 'a' }, diff: {} },
    b: { crawl: { x: 'b' }, diff: {} },
  });
});

// Names that a LIKE pattern, a case-insensitive collation or a comparison
// that ignores trailing spaces would take for one another.
const lookalikes = ['A', 'a', 'a ', '%', '_', '\\', '😀'];

test('partitions, spaces and keys whose names differ only in case, in a trailing space or in a LIKE wildcard keep their own entries when one is reset, cleared or removed', async () => {
  await using database = await pagesDatabase();
  const { run } = database;
  const source = new Keyed(pages({ partitioned: true }));
  source.sites = lookalikes;
  source.spaces = lookalikes;
  const every = (site: string) =>
    Object.fromEntries(
      lookalikes.map((space) => [
        space,
        Object.fromEntries(
          lookalikes.map((key) => [key, `${site}/${space}/${key}`]),
        ),
      ]),
    );
  source.script = Object.fromEntries(
    lookalikes.map((site) => [
      site,
      [
        state(
          Object.fromEntries(
            Object.entries(every(site)).map(([space, keys]) => [
              space,
              { put: Object.entries(keys) },
            ]),
          ),
        ),
      ],
    ]),
  );
  await run(source);
  // _ leaves the listing, a resets, and A removes a key in two spaces.
  source.sites = lookalikes.filter((site) => site !== '_');
  source.script = {
    A: [state({ a: { remove: ['a'] }, _: { remove: ['%'] } })],
    a: [reset, state()],
  };
  await run(source);
  source.sites = lookalikes;
  source.script = {};

  await run(source);

  const none = Object.fromEntries(lookalikes.map((space) => [space, {}]));
  const A = every('A');
  delete A.a?.a;
  delete A._?.['%'];
  assert.deepEqual(source.found, {
    ...Object.fromEntries(lookalikes.map((site) => [site, every(site)])),
    A,
    a: none,
    _: none,
  });
});

test('an entry keeps its value exactly: nested objects, null, text beyond ASCII and U+0000 in a string', async () => {
  await using database = await pagesDatabase();
  const { run } = database;
  const source = new Keyed(pages());
  const values = {
    nested: { a: { b: [1, { c: null }, [true, -1.5]] }, d: 'x' },
    null: null,
    text: 'é ü 😀 عربي 中文',
    nul: 'a\u0000b',
  };
  source.script = {
    pages: [state({ crawl: { put: Object.entries(values) } })],
  };
  await run(source);
  source.script = { pages: [] };

  await run(source);

  assert.deepEqual(source.found.pages, { crawl: values, diff: {} });
});

// 5000 random characters of the CJK block: about 15 KB of UTF-8 that no
// compression shortens, past the 2704 bytes of a Postgres btree row.
const incompressible = () =>
  Array.from({ length: 5000 }, () =>
    String.fromCodePoint(0x4e00 + randomInt(0x5000)),
  ).join('');

test('a 5000-character key in a 5000-character space is saved, read and removed', async () => {
  await using database = await pagesDatabase();
  const { run } = database;
  const source = new Keyed(pages());
  const space = incompressible();
  const key = incompressible();
  source.spaces = [space];
  source.script = {
    pages: [
      state({
        [space]: {
          put: [
            [key, 1],
            ['k', 2],
          ],
        },
      }),
    ],
  };
  await run(source);
  source.script = { pages: [state({ [space]: { remove: [key] } })] };
  await run(source);
  const saved = source.found.pages;
  source.script = { pages: [] };

  await run(source);

  assert.deepEqual(
    { saved, removed: source.found.pages },
    { saved: { [space]: { [key]: 1, k: 2 } }, removed: { [space]: { k: 2 } } },
  );
});
