import assert from 'node:assert/strict';
import { mkdir, mkdtempDisposable, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ClosedWorld } from '@zukhruf/snapshot-differential';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  Pipeline,
  Source,
  type SourceWatchOptions,
  Stream,
  diffSnapshot,
} from '@workspace/elt';

import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from './index.ts';

// An app's store whose every scan lists all its notes, as Apple's stores do.
class Notes extends Source {
  readonly identity = 'notes';
  readonly received: unknown[] = [];
  readonly notes = new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string' } },
      required: ['id', 'title'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  protected readonly catalog = new Catalog([this.notes]);

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

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
  ) {
    this.received.push(state);
    yield* diffSnapshot(
      configuration,
      [
        { id: 'a', title: 'Groceries' },
        { id: 'b', title: 'Trip' },
      ],
      state,
      { policy: new ClosedWorld(), signal: undefined },
    );
  }
}

// An import as the Apple hosts keep one: its rows and its checkpoints in one
// folder, which the user may move or copy to another disk or home.
async function importIn(folder: string, source: Notes) {
  const destination = new SQLiteDestination({
    path: join(folder, 'data.sqlite'),
  });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  return new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(folder, 'checkpoints.sqlite'),
        }),
        steps: [
          new Copy(source.notes, destination.table('notes'), {
            id: 'notes',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
}

test('a copy resumes from its checkpoint after its database and checkpoint store move to another folder', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-relocated-'),
  );
  const before = join(scratch.path, 'before');
  const after = join(scratch.path, 'after');
  await mkdir(before);
  const source = new Notes();
  await (await importIn(before, source)).run();

  await rename(before, after);
  const results = await (await importIn(after, source)).run();

  assert.deepEqual(
    results.map(({ count, deleted }) => ({ count, deleted })),
    [{ count: 0, deleted: 0 }],
  );
  assert.notEqual(source.received[1], null);
});
