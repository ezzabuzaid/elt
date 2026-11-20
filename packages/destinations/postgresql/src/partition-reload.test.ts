import assert from 'node:assert/strict';
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
  Source,
  type SourceMessage,
  Stream,
} from '@eltjs/elt';

import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from './index.ts';

const databases = new Postgres({ environment: process.env });

const items = new Stream({
  name: 'items',
  jsonSchema: {
    type: 'object',
    description: 'Items of accounts.',
    properties: {
      account: { type: 'string', description: 'Account of the item.' },
      id: { type: 'string', description: 'Item id.' },
    },
  },
  primaryKey: ['account', 'id'],
  partitionKey: ['account'],
  supportedSyncModes: ['incremental'],
  sourceDefinedCursor: true,
  emitsDeletes: true,
});

// Two accounts, each emitting what the test scripts for the next run.
class Accounts extends Source {
  readonly identity = 'accounts';
  script: Record<string, (SourceMessage | Error)[]> = {};
  protected readonly catalog = new Catalog([items]);

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
    return [{ account: 'a' }, { account: 'b' }];
  }

  protected override async *extract(
    _configuration: CopyConfiguration,
    _state: unknown,
    partition: Partition | null,
  ) {
    for (const message of this.script[String(partition?.account)] ?? []) {
      if (Error.isError(message)) throw message;
      yield message;
    }
  }
}

const record = (account: string, id: string) => ({
  stream: 'items',
  data: { account, id },
});
const reset = { type: 'RESET' as const, stream: 'items' };
const state = { type: 'STATE' as const, stream: 'items', state: {} };

test('a reset of a partition reloads it into a hidden target: readers keep its old rows until the stream ends, the other partitions load as before, a failed reload resumes, and a deletion that the reload reads stays deleted', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = clients.adopt(
    postgres(url, { max: 1, onnotice: () => {} }),
    (client) => client.end(),
  );
  const destination = new PostgresDestination({ url });
  const source = new Accounts();
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: [
      new Connection({
        name: 'accounts',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({ url }),
        steps: [
          new Copy(items, destination.table('items'), {
            id: 'items',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  const loaded = async () =>
    (await sql`SELECT account, id FROM marts.items ORDER BY account, id`).map(
      ({ account, id }) => `${account}${id}`,
    );
  source.script = {
    a: [record('a', '1'), record('a', '2'), state],
    b: [record('b', '1'), state],
  };
  await pipeline.run();

  source.script = {
    a: [reset, record('a', '3'), record('a', '4'), state, new Error('gone')],
    b: [record('b', '2'), state],
  };
  await assert.rejects(pipeline.run(), PipelineError);
  const whileReloading = await loaded();
  source.script = {
    a: [
      { type: 'DELETE', stream: 'items', key: { account: 'a', id: '3' } },
      record('a', '5'),
      state,
    ],
    b: [state],
  };
  await pipeline.run();

  assert.deepEqual(
    {
      whileReloading,
      reloaded: await loaded(),
      open: [...(await sql`SELECT target FROM _warehouse._elt_reloads`)],
    },
    {
      whileReloading: ['a1', 'a2', 'b1', 'b2'],
      reloaded: ['a4', 'a5', 'b1', 'b2'],
      open: [],
    },
  );
});

test('a reset of a partition that a failure discards before a commit opens no reload, so the next run loads the partition as before', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = clients.adopt(
    postgres(url, { max: 1, onnotice: () => {} }),
    (client) => client.end(),
  );
  const destination = new PostgresDestination({ url });
  const source = new Accounts();
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: [
      new Connection({
        name: 'accounts',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({ url }),
        steps: [
          new Copy(items, destination.table('items'), {
            id: 'items',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  source.script = {
    a: [record('a', '1'), record('a', '2'), state],
    b: [record('b', '1'), state],
  };
  await pipeline.run();
  source.script = {
    a: [reset, record('a', '3'), new Error('gone')],
    b: [record('b', '2'), state],
  };
  await assert.rejects(pipeline.run(), PipelineError);

  source.script = { a: [record('a', '4'), state], b: [state] };
  await pipeline.run();

  assert.deepEqual(
    (await sql`SELECT account, id FROM marts.items ORDER BY account, id`).map(
      ({ account, id }) => `${account}${id}`,
    ),
    ['a1', 'a2', 'a4', 'b1', 'b2'],
  );
});
