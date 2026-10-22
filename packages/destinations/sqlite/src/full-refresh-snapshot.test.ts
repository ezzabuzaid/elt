import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { ClosedWorld } from '@zukhruf/snapshot-differential';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  Pipeline,
  PipelineError,
  Source,
  type SourceWatchOptions,
  Stream,
  diffGroupedSnapshot,
  diffSnapshot,
} from '@workspace/elt';

import { SQLiteDestination, SQLiteSyncHistory } from './index.ts';

// A source whose upstream is current whenever it is read.
abstract class LiveSource<
  Context extends AsyncDisposable = AsyncDisposable,
> extends Source<Context> {
  override async currentAsOf() {
    return null;
  }
}

// A sync history installed in each destination's file, as a host installs it
// before the first pass.
async function installedHistory(...destinations: SQLiteDestination[]) {
  const history = new SQLiteSyncHistory();
  await history.install(destinations);
  return history;
}

test('a full refresh checks a snapshot stream’s declaration as an incremental copy does', async () => {
  const deleting = new Stream({
    name: 'deleting',
    jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  const forgetting = new Stream({
    name: 'forgetting',
    jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
  });
  const uncursored = new Stream({
    name: 'uncursored',
    jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
  });
  const rows = [{ id: 'a' }];
  class MisdeclaredSource extends LiveSource {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'misdeclared-snapshot-test';
    protected readonly catalog = new Catalog([
      deleting,
      forgetting,
      uncursored,
    ]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(
      configuration: CopyConfiguration,
      state: unknown,
    ) {
      if (configuration.stream === deleting)
        yield* diffSnapshot(configuration, rows, state, { signal: undefined });
      else if (configuration.stream === forgetting)
        yield* diffGroupedSnapshot(
          configuration,
          [{ key: 'g', fingerprint: '1', records: () => rows }],
          state,
          { policy: new ClosedWorld(), signal: undefined },
        );
      else
        yield* diffSnapshot(configuration, rows, state, { signal: undefined });
    }
  }

  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-full-refresh-declaration-'),
  );
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'd.sqlite'),
  });
  const pipeline = new Pipeline({
    history: await installedHistory(destination),
    connections: [
      new Connection({
        name: 'test',
        source: new MisdeclaredSource(),
        destination,
        steps: [
          new Copy(deleting, destination.table('deleting')),
          new Copy(forgetting, destination.table('forgetting')),
          new Copy(uncursored, destination.table('uncursored')),
        ],
      }),
    ],
  });

  const error = await pipeline.run().then(
    () => assert.fail('the misdeclared copies should fail'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.deepEqual(
    error.results.map(({ copy, count, failures }) => [
      copy.from.name,
      count,
      failures.map(({ error }) =>
        error instanceof Error ? error.message : String(error),
      ),
    ]),
    [
      [
        'deleting',
        0,
        [
          'Stream deleting emits deletions, so its snapshot diff needs a policy, such as ClosedWorld',
        ],
      ],
      [
        'forgetting',
        0,
        [
          'Stream forgetting emits no deletions, so its snapshot diff takes no policy',
        ],
      ],
      [
        'uncursored',
        0,
        [
          'Stream uncursored must declare sourceDefinedCursor to diff snapshots',
        ],
      ],
    ],
  );
});

test('a full refresh of a snapshot stream loads every record of each scan as scanned, and a later full refresh replaces them', async () => {
  let rows: { id: string; name: string }[] = [];
  const items = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  class ItemsSource extends LiveSource {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'full-refresh-snapshot-test';
    protected readonly catalog = new Catalog([items]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(
      configuration: CopyConfiguration,
      state: unknown,
    ) {
      yield* diffSnapshot(configuration, rows, state, {
        policy: new ClosedWorld(),
        signal: undefined,
      });
    }
  }

  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-full-refresh-snapshot-'),
  );
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'd.sqlite'),
  });
  const copy = new Copy(items, destination.table('items'));
  const pipeline = new Pipeline({
    history: await installedHistory(destination),
    connections: [
      new Connection({
        name: 'test',
        source: new ItemsSource(),
        destination,
        steps: [copy],
      }),
    ],
  });
  const loaded = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare('SELECT id, name FROM items ORDER BY id')
      .all()
      .map(({ id, name }) => ({ id, name }));
  };

  rows = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 3, deleted: 0 }]);
  assert.deepEqual(loaded(), rows);

  rows = [
    { id: 'a', name: 'A2' },
    { id: 'c', name: 'C' },
  ];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 2, deleted: 0 }]);
  assert.deepEqual(loaded(), rows);
});

test('a full refresh of a grouped snapshot stream reads every group, also one whose fingerprint did not change', async () => {
  type Group = { key: string; rows: { id: string; name: string }[] };
  let groups: Group[] = [];
  const items = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  class GroupedSource extends LiveSource {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'full-refresh-grouped-snapshot-test';
    protected readonly catalog = new Catalog([items]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(
      configuration: CopyConfiguration,
      state: unknown,
    ) {
      yield* diffGroupedSnapshot(
        configuration,
        groups.map(({ key, rows }) => ({
          key,
          fingerprint: 'unchanged',
          records: () => rows,
        })),
        state,
        { policy: new ClosedWorld(), signal: undefined },
      );
    }
  }

  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-full-refresh-grouped-'),
  );
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'd.sqlite'),
  });
  const copy = new Copy(items, destination.table('items'));
  const pipeline = new Pipeline({
    history: await installedHistory(destination),
    connections: [
      new Connection({
        name: 'test',
        source: new GroupedSource(),
        destination,
        steps: [copy],
      }),
    ],
  });
  const loaded = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare('SELECT id, name FROM items ORDER BY id')
      .all()
      .map(({ id, name }) => ({ id, name }));
  };

  groups = [
    {
      key: 'one',
      rows: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
    },
    { key: 'two', rows: [{ id: 'c', name: 'C' }] },
  ];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 3, deleted: 0 }]);
  assert.deepEqual(loaded(), [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ]);

  // Group one keeps its fingerprint but changes a record: a full refresh has
  // no saved fingerprint to trust, so it reads the group again.
  groups = [
    {
      key: 'one',
      rows: [
        { id: 'a', name: 'A2' },
        { id: 'b', name: 'B' },
      ],
    },
    { key: 'two', rows: [{ id: 'c', name: 'C' }] },
  ];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 3, deleted: 0 }]);
  assert.deepEqual(loaded(), [
    { id: 'a', name: 'A2' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ]);
});
