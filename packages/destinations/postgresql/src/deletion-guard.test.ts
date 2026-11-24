import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  type CopyConfiguration,
  Gauge,
  Pipeline,
  Source,
  type SourceMessage,
  Stream,
} from '@eltjs/elt';

import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
  type PostgresTable,
} from './index.ts';

const databases = new Postgres({ environment: process.env });

// The upstream of a test source, which the test fills before it reads.
class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// Reads the messages a test scripts for its stream.
class Scripted extends Source {
  readonly identity = 'scripted';
  protected readonly catalog: Catalog;
  readonly #messages: readonly SourceMessage[];

  constructor(stream: Stream, messages: readonly SourceMessage[]) {
    super();
    this.catalog = new Catalog([stream]);
    this.#messages = messages;
  }

  override coverage() {
    return { description: 'test', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  override changeSignals(streams: readonly Stream[]): ChangeSignal[] {
    return [{ gauge: new Filled(), streams, interval: 1000, timeout: 1000 }];
  }

  protected override async *extract(_configuration: CopyConfiguration) {
    yield* this.#messages;
  }
}

// Notes keyed by id; a newer copy of a note has a greater version, and the
// upstream deletes a note at a version too. A version of type type.
const notes = (type: 'integer' | 'string' = 'integer') =>
  new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      description: 'A note.',
      properties: {
        id: { type: 'string', description: 'Note id.' },
        version: { type, description: 'Version of the note.' },
        body: { type: 'string', description: 'Text of the note.' },
      },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    emitsDeletes: true,
  });

const note = (
  id: string,
  version: string | number,
  body = `${id}@${version}`,
) => ({
  stream: 'notes',
  data: { id, version, body },
});
const tombstone = (id: string, cursor: string | number) => ({
  type: 'DELETE' as const,
  stream: 'notes',
  key: { id },
  cursor,
});
const checkpoint = (read: number) => ({
  type: 'STATE' as const,
  stream: 'notes',
  state: { read },
});

// An incremental copy that keeps the newest version of each note:
// cursor_newer, as a copy with a cursor field deduplicates by default.
const incremental = (stream: Stream, destination: PostgresDestination) =>
  new Copy(stream, destination.table('notes'), {
    id: 'notes',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    cursorField: 'version',
  });

// A client of the test's own, ended with the test.
function client(url: string, stack: AsyncDisposableStack): postgres.Sql {
  return stack.adopt(postgres(url, { max: 1, onnotice: () => {} }), (sql) =>
    sql.end(),
  );
}

// A destination of the database, its checkpoints, and a pass of one copy
// that reads the messages a test scripts for it.
function warehouse(url: string, stream = notes()) {
  const destination = new PostgresDestination({ url });
  const checkpoints = new PostgresCheckpointStore({ url });
  const pass = (
    messages: readonly SourceMessage[],
    copy: Copy<PostgresTable> = incremental(stream, destination),
  ) =>
    new Pipeline({
      clock: globalThis,
      history: new PostgresSyncHistory({ url }),
      connections: [
        new Connection({
          name: 'notes',
          source: new Scripted(stream, messages),
          destination,
          checkpoints,
          steps: [copy],
        }),
      ],
    }).run();
  return { destination, stream, checkpoints, pass };
}

// The notes that readers see now. An integer version is stored as a
// bigint, which the client reads as text.
async function loaded(sql: postgres.Sql, version = 'version::int') {
  return (
    await sql.unsafe(
      `SELECT id, ${version} AS version, body FROM marts.notes ORDER BY id COLLATE "C"`,
    )
  ).map((row) => ({ ...row }));
}

// What each copy of a run read and deleted.
const counts = (results: readonly { count: number; deleted: number }[]) =>
  results.map(({ count, deleted }) => ({ count, deleted }));

// The newest position of the database.
async function newest(destination: PostgresDestination): Promise<string> {
  const positions = await destination.positions();
  if ('expired' in positions) assert.fail(positions.expired);
  const position = positions.at(-1);
  if (position === undefined) assert.fail('the database has no position yet');
  return position;
}

// The rows that commits replaced or removed from the notes, as their history
// keeps them.
async function replaced(sql: postgres.Sql) {
  const names = await sql<{ name: string }[]>`
    SELECT relname AS name FROM pg_class
    WHERE relnamespace = '_warehouse'::regnamespace AND relkind = 'r' AND relname LIKE '\_elt\_history\_%'`;
  assert.equal(names.length, 1, 'the database has one history');
  return (
    await sql.unsafe(
      `SELECT id, version::int AS version, body FROM _warehouse."${names[0]?.name}" ORDER BY id COLLATE "C", version`,
    )
  ).map((row) => ({ ...row }));
}

// The rows a query reads as of a position.
async function asOf(
  destination: PostgresDestination,
  query: string,
  position: string,
) {
  const reading = await destination.reading(position);
  if ('expired' in reading) assert.fail(reading.expired);
  await using _reading = reading;
  return (await reading.sql.unsafe(query)).map((row) => ({ ...row }));
}

// The commit that wrote each stored note. The commit is internal, so only
// the raw table shows it.
async function commits(sql: postgres.Sql) {
  return (
    await sql`SELECT id, committed_in FROM _warehouse.raw_notes ORDER BY id COLLATE "C"`
  ).map((row) => ({ ...row }));
}

test('a tombstone older than the stored row deletes nothing: the row keeps its body and its commit, and the history keeps no copy of it', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, pass } = warehouse(database.connectionString);
  await pass([note('a', 5), checkpoint(1)]);
  const before = await newest(destination);
  const written = await commits(sql);

  const result = await pass([tombstone('a', 3), checkpoint(2)]);

  // The run counts each deletion it applied, as it counts each record that
  // cursor_newer discards.
  assert.deepEqual(counts(result), [{ count: 0, deleted: 1 }]);
  assert.deepEqual(await loaded(sql), [{ id: 'a', version: 5, body: 'a@5' }]);
  assert.deepEqual(await commits(sql), written);
  assert.deepEqual(await replaced(sql), []);
  assert.deepEqual(
    await asOf(
      destination,
      'SELECT id, version::int AS version FROM marts.notes',
      before,
    ),
    [{ id: 'a', version: 5 }],
  );
});

test('a tombstone newer than the stored row deletes it, and the history keeps the row', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { pass } = warehouse(database.connectionString);
  await pass([note('a', 5), checkpoint(1)]);

  const result = await pass([tombstone('a', 7), checkpoint(2)]);

  assert.deepEqual(counts(result), [{ count: 0, deleted: 1 }]);
  assert.deepEqual(await loaded(sql), []);
  assert.deepEqual(await replaced(sql), [{ id: 'a', version: 5, body: 'a@5' }]);
});

test('a tombstone with the cursor of the stored row deletes nothing, as a record with that cursor replaces nothing', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { pass } = warehouse(database.connectionString);
  await pass([note('a', 5), checkpoint(1)]);

  await pass([tombstone('a', 5), checkpoint(2)]);

  assert.deepEqual(await loaded(sql), [{ id: 'a', version: 5, body: 'a@5' }]);
  assert.deepEqual(await replaced(sql), []);
});

test('in one commit, a tombstone older than a record before it loses to the record', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { pass } = warehouse(database.connectionString);

  await pass([note('a', 5), tombstone('a', 3), checkpoint(1)]);

  assert.deepEqual(await loaded(sql), [{ id: 'a', version: 5, body: 'a@5' }]);
});

test('in one commit, a tombstone newer than the records on both sides of it wins, so neither record loads', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { pass } = warehouse(database.connectionString);

  await pass([note('a', 1), tombstone('a', 6), note('a', 3), checkpoint(1)]);

  assert.deepEqual(await loaded(sql), []);
});

test('in one commit, of a record and a tombstone with the same cursor the first wins, whichever it is', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { pass } = warehouse(database.connectionString);
  await pass([note('b', 2), checkpoint(1)]);

  await pass([
    note('a', 4),
    tombstone('a', 4),
    tombstone('b', 4),
    note('b', 4),
    checkpoint(2),
  ]);

  assert.deepEqual(await loaded(sql), [{ id: 'a', version: 4, body: 'a@4' }]);
});

test('in one commit, of two tombstones the greatest cursor wins, whichever comes first', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { pass } = warehouse(database.connectionString);
  await pass([note('a', 5), note('b', 5), checkpoint(1)]);

  await pass([
    tombstone('a', 7),
    tombstone('a', 3),
    tombstone('b', 3),
    tombstone('b', 7),
    checkpoint(2),
  ]);

  assert.deepEqual(await loaded(sql), []);
});

test('a replay after a reset of the checkpoint changes nothing: its old tombstone keeps the newer row, which keeps its commit, and the history gains no row', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { checkpoints, pass } = warehouse(database.connectionString);
  const changes = [
    note('a', 1),
    checkpoint(1),
    tombstone('a', 2),
    checkpoint(2),
    note('a', 3),
    checkpoint(3),
  ];
  await pass(changes);
  const written = await commits(sql);
  const history = await replaced(sql);

  await checkpoints.reset('notes');
  await pass(changes);

  assert.deepEqual(await loaded(sql), [{ id: 'a', version: 3, body: 'a@3' }]);
  assert.deepEqual(await commits(sql), written);
  assert.deepEqual(history, [{ id: 'a', version: 1, body: 'a@1' }]);
  assert.deepEqual(await replaced(sql), history);
});

test('a full refresh that replaces its target ranks tombstones with records by cursor too', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, stream, pass } = warehouse(database.connectionString);
  const refresh = new Copy(stream, destination.table('notes'), {
    id: 'notes',
    syncMode: 'full_refresh',
    destinationSyncMode: 'overwrite_dedup',
    cursorField: 'version',
  });

  await pass(
    [note('a', 5), tombstone('a', 3), note('b', 1), tombstone('b', 2)],
    refresh,
  );

  assert.deepEqual(await loaded(sql), [{ id: 'a', version: 5, body: 'a@5' }]);
});

test('a text cursor of a tombstone compares by bytes, not by the collation of the database, against the stored row and in its commit', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const server = client(database.connectionString, clients);
  // Platform setup that no operation exposes: a database whose collation
  // sorts 'a' before 'B', as most locales do. By bytes, 'B' sorts first.
  const url = new URL(database.connectionString);
  const name = `${url.pathname.slice(1)}_icu`;
  url.pathname = `/${name}`;
  await server.unsafe(
    `CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C' LOCALE_PROVIDER icu ICU_LOCALE 'en-US'`,
  );
  clients.defer(async () => {
    await server.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  });
  const sql = client(url.href, clients);
  const [collated] = await sql`SELECT 'a' < 'B' AS before`;
  assert.equal(collated?.before, true);
  const { pass } = warehouse(url.href, notes('string'));
  await pass([note('x', 'a'), checkpoint(1)]);

  await pass([
    tombstone('x', 'B'),
    note('y', 'a'),
    tombstone('y', 'B'),
    checkpoint(2),
  ]);

  assert.deepEqual(await loaded(sql, 'version'), [
    { id: 'x', version: 'a', body: 'x@a' },
    { id: 'y', version: 'a', body: 'y@a' },
  ]);
});
