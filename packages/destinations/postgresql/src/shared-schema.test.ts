import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';

import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  Pipeline,
  Source,
  Stream,
} from '@eltjs/elt';

import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from './index.ts';

const databases = new Postgres({ environment: process.env });

// Lets every source of a test go on only once all of them are extracting, so
// their streams end, and their first commits start, together.
class Barrier extends EventEmitter {
  #waiting: number;

  constructor(parties: number) {
    super();
    this.#waiting = parties;
  }

  async arrive(): Promise<void> {
    this.#waiting -= 1;
    if (this.#waiting === 0) this.emit('open');
    else await once(this, 'open');
  }
}

class Rows extends Source {
  readonly identity: string;
  readonly stream: Stream;
  protected readonly catalog: Catalog;
  readonly #barrier: Barrier;

  constructor(identity: string, barrier: Barrier) {
    super();
    this.identity = identity;
    this.#barrier = barrier;
    this.stream = new Stream({
      name: 'rows',
      jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
      supportedSyncModes: ['full_refresh', 'incremental'],
      sourceDefinedCursor: true,
    });
    this.catalog = new Catalog([this.stream]);
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

  protected override async *extract(configuration: CopyConfiguration) {
    await this.#barrier.arrive();
    yield { stream: this.stream.name, data: { id: this.identity } };
    if (configuration.syncMode === 'incremental')
      yield { type: 'STATE' as const, stream: this.stream.name, state: {} };
  }
}

test('connections whose first loads make one new schema at the same moment all commit', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(database.connectionString, { max: 1, onnotice: () => {} }),
    (client) => client.end(),
  );
  const destination = new PostgresDestination({
    url: database.connectionString,
    schema: 'raw',
  });
  const names = ['billing', 'central', 'impact', 'payroll', 'staffing'];
  const barrier = new Barrier(names.length);

  await new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url: database.connectionString }),
    connections: names.map((name) => {
      const source = new Rows(name, barrier);
      return new Connection({
        name,
        source,
        destination,
        steps: [new Copy(source.stream, destination.table(name))],
      });
    }),
  }).run();

  const loaded = await Promise.all(
    names.map(
      async (name) => (await sql.unsafe(`SELECT id FROM raw."${name}"`))[0]?.id,
    ),
  );
  assert.deepEqual(loaded, names);
});

test('incremental connections that keep their checkpoints in one new schema all start and commit at the same moment', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(database.connectionString, { max: 1, onnotice: () => {} }),
    (client) => client.end(),
  );
  const url = database.connectionString;
  const destination = new PostgresDestination({ url, schema: 'raw' });
  const names = ['billing', 'central', 'impact', 'payroll', 'staffing'];
  const barrier = new Barrier(names.length);

  await new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: names.map((name) => {
      const source = new Rows(name, barrier);
      return new Connection({
        name,
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({ url, schema: 'raw' }),
        steps: [
          new Copy(source.stream, destination.table(name), {
            id: name,
            syncMode: 'incremental',
            destinationSyncMode: 'append',
          }),
        ],
      });
    }),
  }).run();

  const checkpoints = await sql.unsafe(
    'SELECT id FROM raw._elt_checkpoints ORDER BY id',
  );
  assert.deepEqual(
    checkpoints.map(({ id }) => id),
    names,
  );
});
