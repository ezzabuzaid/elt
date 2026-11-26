import assert from 'node:assert/strict';
import { join } from 'node:path';

import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import { ClosedWorld } from '@zukhruf/snapshot-differential';
import { open } from '@zukhruf/sqlite-open';

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
  Stream,
  diffGroupedSnapshot,
  resumeGroupedSnapshot,
} from '@eltjs/elt';

import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from './index.ts';
import { storedRows } from './testing/stored-rows.ts';

// The items of a site's pages, by site and id. With partitioned, each site
// is a partition.
const items = ({ name = 'items', partitioned = false } = {}) =>
  new Stream({
    name,
    jsonSchema: {
      type: 'object',
      description: 'An item of a page.',
      properties: {
        site: { type: 'string', description: 'Site of the page.' },
        id: { type: 'string', description: 'Id of the item.' },
      },
      required: ['site', 'id'],
    },
    primaryKey: ['site', 'id'],
    ...(partitioned ? { partitionKey: ['site'] } : {}),
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });

type Page = {
  readonly url: string;
  readonly version: string;
  readonly items: readonly string[];
};

// The pages of each site, one group of items each. With parts, a scan diffs
// one page in each part and saves after it, as the web source diffs a crawl
// page by page, and its state names the next page, so the scan of a run
// that fails goes on in the next run; the part that ends the scan lists no
// page. Without parts, one diff lists every page and saves once.
class Site extends Source {
  readonly identity = 'site';
  readonly streams: readonly Stream[];
  protected readonly catalog: Catalog;
  // By the partition's site, or by the stream's name.
  pages: Record<string, readonly Page[]> = {};
  sites = ['a', 'b'];
  parts = true;
  // The page at which a scan stops, failing the run.
  failAt: string | undefined;

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
    state: unknown,
    partition: Partition | null,
    _context: AsyncDisposable,
    signal: AbortSignal | undefined,
    entries: SavedEntries,
  ): AsyncGenerator<SourceMessage> {
    const site = String(partition?.site ?? configuration.stream.name);
    const groups = (this.pages[site] ?? []).map((page) => ({
      key: page.url,
      fingerprint: page.version,
      records: () => page.items.map((id) => ({ site, id })),
    }));
    const options = { policy: new ClosedWorld(), signal };
    let snapshot = await resumeGroupedSnapshot(configuration, entries);
    if (!this.parts) {
      yield* diffGroupedSnapshot(configuration, groups, snapshot, options);
      return;
    }
    const from =
      typeof state === 'object' &&
      state !== null &&
      'next' in state &&
      typeof state.next === 'number'
        ? state.next
        : 0;
    for (let index = from; index <= groups.length; index++) {
      const group = groups[index];
      if (group !== undefined && group.key === this.failAt)
        throw new Error(`Page ${group.key} did not answer`);
      for await (const message of diffGroupedSnapshot(
        configuration,
        group === undefined ? [] : [group],
        snapshot,
        { ...options, continues: group !== undefined },
      ))
        if ('type' in message && message.type === 'STATE') {
          snapshot = message.snapshot;
          yield {
            type: 'STATE',
            stream: message.stream,
            state: { next: group === undefined ? 0 : index + 1 },
            entries: message.entries,
          };
        } else yield message;
    }
  }
}

// A destination, its checkpoints, and a run of an incremental copy of each
// stream of source, whose id is the stream's name.
function siteFile(directory: string) {
  const destination = new SQLiteDestination({
    path: join(directory, 'data.sqlite'),
  });
  const statePath = join(directory, 'state.sqlite');
  const run = async (source: Site) =>
    (
      await new Pipeline({
        clock: globalThis,
        history: new SQLiteSyncHistory(),
        connections: [
          new Connection({
            name: 'site',
            source,
            destination,
            checkpoints: new SQLiteCheckpointStore({ path: statePath }),
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
      }).run()
    ).map(({ count, deleted }) => ({ count, deleted }));
  const loaded = () =>
    storedRows(destination.path, 'SELECT site, id FROM items')
      .map(({ site, id }) => `${String(site)}${String(id)}`)
      .sort();
  // The keys of a space of the copy's checkpoint entries.
  const keys = (space: string, id = 'items') =>
    storedRows(
      statePath,
      `SELECT key FROM checkpoint_entries WHERE id = '${id}' AND space = '${space}' ORDER BY key`,
    ).map(({ key }) => String(key));
  return { statePath, run, loaded, keys };
}

const page = (url: string, version: string, ...ids: string[]): Page => ({
  url,
  version,
  items: ids,
});

test('a scan in parts that a failed run leaves open goes on in the next run with the pages its saved parts listed, so the part that ends it deletes only what no part listed', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-grouped-');
  const { run, loaded } = siteFile(scratch.path);
  const source = new Site(items());
  source.pages = {
    items: [
      page('p1', 'v1', 'x'),
      page('p2', 'v1', 'y'),
      page('p3', 'v1', 'z'),
    ],
  };
  await run(source);

  source.failAt = 'p2';
  await assert.rejects(run(source), PipelineError);
  source.failAt = undefined;
  const resumed = await run(source);

  assert.deepEqual(resumed, [{ count: 0, deleted: 0 }]);
  assert.deepEqual(loaded(), ['itemsx', 'itemsy', 'itemsz']);
});

void test.each([{ parts: true }, { parts: false }], ({ parts }) =>
  test(`a resumed scan ${parts ? 'in parts' : 'in one diff'} deletes the records of a page it no longer finds and its saved group, and loads nothing for the pages that did not change`, async () => {
    await using scratch = await new TemporaryFiles().directory('elt-grouped-');
    const { run, loaded, keys } = siteFile(scratch.path);
    const source = new Site(items());
    source.parts = parts;
    const a = page('a', 'v1', '1', '2');
    const c = page('c', 'v1', '5');
    source.pages = { items: [a, page('b', 'v1', '3', '4'), c] };
    await run(source);

    source.pages = { items: [a, c] };
    const resumed = await run(source);

    assert.deepEqual(resumed, [{ count: 0, deleted: 2 }]);
    assert.deepEqual(loaded(), ['items1', 'items2', 'items5']);
    assert.deepEqual(
      ['diff', 'diff:unknown', 'diff:listed'].map((space) => keys(space)),
      [['a', 'c'], [], []],
    );
  }),
);

test('each page save of a scan in parts writes that page’s diff entry and its listed entry and no other entry, the save that ends the scan removes the listed entries, and a later scan writes the diff entry of a changed page only', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-grouped-');
  const { statePath, run } = siteFile(scratch.path);
  const source = new Site(items());
  // A scan of no page makes the checkpoint store's tables.
  await run(source);
  // Each write of an entry, with the state of the save that writes it: the
  // store writes the checkpoint's row before its entries.
  {
    using database = open(statePath);
    database.exec(`
      CREATE TABLE writes (seq INTEGER PRIMARY KEY, kind TEXT, space TEXT, key TEXT, state TEXT);
      CREATE TRIGGER put AFTER INSERT ON checkpoint_entries BEGIN
        INSERT INTO writes (kind, space, key, state) VALUES ('put', new.space, new.key, (SELECT state FROM checkpoints WHERE id = new.id));
      END;
      CREATE TRIGGER put_again AFTER UPDATE ON checkpoint_entries BEGIN
        INSERT INTO writes (kind, space, key, state) VALUES ('put', new.space, new.key, (SELECT state FROM checkpoints WHERE id = new.id));
      END;
      CREATE TRIGGER removed AFTER DELETE ON checkpoint_entries BEGIN
        INSERT INTO writes (kind, space, key, state) VALUES ('remove', old.space, old.key, (SELECT state FROM checkpoints WHERE id = old.id));
      END;
    `);
  }
  // The writes of each save, in the order of the saves, as the state of the
  // save and the writes it made of spaces, in any order within the save.
  const written = (spaces = ['diff', 'diff:unknown', 'diff:listed']) => {
    using database = open(statePath);
    const saves: { state: string; writes: string[] }[] = [];
    for (const { kind, space, key, state } of database
      .prepare('SELECT kind, space, key, state FROM writes ORDER BY seq')
      .all()) {
      if (!spaces.includes(String(space))) continue;
      let save = saves.at(-1);
      if (save?.state !== String(state)) {
        save = { state: String(state), writes: [] };
        saves.push(save);
      }
      save.writes.push(`${String(kind)} ${String(space)} ${String(key)}`);
    }
    return saves.map(
      ({ state, writes }) => `${state} ${writes.toSorted().join(', ')}`,
    );
  };
  const forget = () => {
    using database = open(statePath);
    database.exec('DELETE FROM writes');
  };
  const pages = [
    page('a', 'v1', '1'),
    page('b', 'v1', '2'),
    page('c', 'v1', '3'),
  ];

  source.pages = { items: pages };
  await run(source);
  const first = written();
  forget();
  await run(source);
  const unchanged = written(['diff', 'diff:unknown']);
  forget();
  source.pages = { items: pages.with(1, page('b', 'v2', '2', '4')) };
  await run(source);
  const changed = written(['diff', 'diff:unknown']);

  assert.deepEqual(first, [
    '{"next":1} put diff a, put diff:listed a',
    '{"next":2} put diff b, put diff:listed b',
    '{"next":3} put diff c, put diff:listed c',
    '{"next":0} remove diff:listed a, remove diff:listed b, remove diff:listed c',
  ]);
  assert.deepEqual([unchanged, changed], [[], ['{"next":2} put diff b']]);
});

// A source that diffs in parts writes a state of its own; one that yields
// the messages of one diff as they are saves the diff's.
test('a grouped stream that yields the messages of its diff as they are saves null as its checkpoint state, and its snapshot in its entries', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-grouped-');
  const { statePath, run, keys } = siteFile(scratch.path);
  const source = new Site(items());
  source.parts = false;
  source.pages = { items: [page('a', 'v1', '1'), page('b', 'v1', '2')] };

  await run(source);

  assert.deepEqual(storedRows(statePath, 'SELECT state FROM checkpoints'), [
    { state: 'null' },
  ]);
  assert.deepEqual(keys('diff'), ['a', 'b']);
});

// Each stream keeps its own entries (ADR 0035, checkpoint-entries.test.ts);
// within one, Source.read scopes them to the partition.
test('two partitions of one stream that give one page key keep their own snapshots: one that no longer gives the page deletes only its own records', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-grouped-');
  const { run, loaded } = siteFile(scratch.path);
  const source = new Site(items({ partitioned: true }));
  source.pages = {
    a: [page('home', 'v1', 'a')],
    b: [page('home', 'v1', 'b')],
  };
  await run(source);

  source.pages = { a: [], b: [page('home', 'v1', 'b')] };
  const resumed = await run(source);

  assert.deepEqual(resumed, [{ count: 0, deleted: 1 }]);
  assert.deepEqual(loaded(), ['bb']);
});

void test.each(
  [
    {
      next: 'deletes it when no page gives it',
      b: page('b', 'v1', 'z'),
      expected: {
        result: { count: 0, deleted: 1 },
        loaded: ['itemsx', 'itemsz'],
      },
    },
    {
      next: 'loads nothing for it when another page gives it unchanged',
      b: page('b', 'v2', 'z', 'y'),
      expected: {
        result: { count: 0, deleted: 0 },
        loaded: ['itemsx', 'itemsy', 'itemsz'],
      },
    },
  ],
  ({ next, b, expected }) =>
    test(`a record that left a page in a part that a failed run saved waits for the part that ends the scan in the next run, which ${next}`, async () => {
      await using scratch = await new TemporaryFiles().directory(
        'elt-grouped-',
      );
      const { run, loaded } = siteFile(scratch.path);
      const source = new Site(items());
      source.pages = {
        items: [page('a', 'v1', 'x', 'y'), page('b', 'v1', 'z')],
      };
      await run(source);
      source.pages = { items: [page('a', 'v2', 'x'), page('b', 'v1', 'z')] };
      source.failAt = 'b';
      await assert.rejects(run(source), PipelineError);

      source.failAt = undefined;
      source.pages = { items: [page('a', 'v2', 'x'), b] };
      const resumed = await run(source);

      assert.deepEqual({ result: resumed[0], loaded: loaded() }, expected);
    }),
);
