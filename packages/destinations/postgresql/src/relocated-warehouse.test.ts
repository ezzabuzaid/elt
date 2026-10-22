import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ClosedWorld } from '@zukhruf/snapshot-differential';
import { Docker, TestRun } from '@zukhruf/testing/docker';
import { Postgres } from '@zukhruf/testing/postgres';

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
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from './index.ts';

const databases = new Postgres({
  docker: new Docker({ testRun: TestRun.fromEnvironment(process.env) }),
});

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

// One pass into the warehouse at url, its checkpoints beside the rows.
async function passInto(url: string, source: Notes) {
  const history = new PostgresSyncHistory({ url });
  await history.install();
  const destination = new PostgresDestination({ url, schema: 'notes' });
  return new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({ url, schema: 'notes' }),
        steps: [
          new Copy(source.notes, destination.table('notes'), {
            id: 'notes',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  }).run();
}

test('a copy resumes when its warehouse is reached through another host name', async () => {
  await using database = await databases.database();
  const through = (host: string) => {
    const url = new URL(database.connectionString);
    url.hostname = host;
    return url.href;
  };
  const source = new Notes();
  await passInto(through('localhost'), source);

  const results = await passInto(through('127.0.0.1'), source);

  assert.deepEqual(
    results.map(({ count, deleted }) => ({ count, deleted })),
    [{ count: 0, deleted: 0 }],
  );
  assert.notEqual(source.received[1], null);
});
