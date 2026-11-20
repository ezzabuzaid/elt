import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

import { PostgresDestination, PostgresSyncHistory } from './index.ts';

const databases = new Postgres({ environment: process.env });

class Notes extends Source {
  readonly identity = 'notes';
  readonly notes = new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      description: 'A note.',
      properties: { id: { type: 'string', description: 'Note id.' } },
      required: ['id'],
    },
    supportedSyncModes: ['full_refresh'],
  });
  protected readonly catalog = new Catalog([this.notes]);

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
    yield { stream: configuration.stream.name, data: { id: 'n1' } };
  }
}

test('a role that a sync history names as a reader reads the positions of the database, and the database as of one, with its own session', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = clients.adopt(
    postgres(url, { max: 1, onnotice: () => {} }),
    (client) => client.end(),
  );
  // Roles belong to the whole server, which other tests share.
  const role = `reader_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  await sql.unsafe(`
    CREATE ROLE ${role} LOGIN PASSWORD '${password}';
    CREATE SCHEMA marts;
    GRANT USAGE ON SCHEMA marts TO ${role};
    ALTER DEFAULT PRIVILEGES IN SCHEMA marts GRANT SELECT ON TABLES TO ${role};
  `);
  clients.defer(async () => {
    await sql.unsafe(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
  });
  const reader = new URL(url);
  reader.username = role;
  reader.password = password;
  const readings = new PostgresDestination({ url: reader.href });
  const source = new Notes();
  const destination = new PostgresDestination({ url });
  const pipeline = (readers: readonly string[]) =>
    new Pipeline({
      clock: globalThis,
      history: new PostgresSyncHistory({ url, readers }),
      connections: [
        new Connection({
          name: 'notes',
          source,
          destination,
          steps: [new Copy(source.notes, destination.table('notes'))],
        }),
      ],
    });
  await pipeline([]).run();
  const refused = await readings.positions().then(
    () => 'read',
    (error: unknown) => (Error.isError(error) ? error.message : String(error)),
  );

  await pipeline([role]).run();
  const positions = await readings.positions();
  const reading = await readings.reading();
  if ('expired' in reading) assert.fail(reading.expired);
  await using _reading = reading;

  assert.match(refused, /permission denied/);
  assert.ok(Array.isArray(positions) && positions.length > 0);
  assert.deepEqual(
    [...(await reading.sql`SELECT id FROM marts.notes`)],
    [{ id: 'n1' }],
  );
});
