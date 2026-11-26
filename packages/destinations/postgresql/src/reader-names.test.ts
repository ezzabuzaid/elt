import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  type LoadedRow,
  Pipeline,
  Rule,
  type RuleResult,
  type RuleValues,
  Source,
  type SourceMessage,
  Stream,
  TableRule,
  type TableRuleResult,
} from '@eltjs/elt';

import {
  ComputedDataset,
  PostgresDestination,
  PostgresSyncHistory,
  type PostgresTable,
  View,
} from './index.ts';

const databases = new Postgres({ environment: process.env });

// Notes with ids and titles, described as the stream says; each run yields
// the messages that the test gives it.
class Notes extends Source {
  readonly identity = 'notes';
  readonly notes: Stream;
  protected readonly catalog: Catalog;
  messages: readonly SourceMessage[] = [];

  constructor(title: { type: 'string'; description?: string }) {
    super();
    this.notes = new Stream({
      name: 'notes',
      jsonSchema: {
        type: 'object',
        description: 'Notes a person wrote.',
        properties: {
          id: { type: 'string', description: 'Note id.' },
          title,
        },
        required: ['id', 'title'],
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh'],
      supportsFileTransfer: true,
    });
    this.catalog = new Catalog([this.notes]);
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

  protected override async *extract(_configuration: CopyConfiguration) {
    yield* this.messages;
  }
}

const note = (id: string, title: string): SourceMessage => ({
  stream: 'notes',
  data: { id, title },
});

const length = {
  length: { type: 'integer', description: 'Characters in the title.' },
} as const;

class TitleLength extends Rule<string, typeof length> {
  override readonly key = { name: 'id', description: 'Note id.' };
  override readonly output = length;
  override readonly batch = 10;
  override readonly concurrency = 1;

  override read(row: LoadedRow) {
    return typeof row.id === 'string' && typeof row.title === 'string'
      ? { key: row.id, input: row.title }
      : null;
  }

  override async identity() {
    return 'title-length-1';
  }

  override async compute(
    titles: readonly string[],
  ): Promise<readonly RuleResult<RuleValues<typeof length>>[]> {
    return titles.map((title) => ({ value: { length: title.length } }));
  }
}

const word = {
  word: { type: 'text', description: 'A word of the title.' },
} as const;
const place = {
  index: { type: 'integer', description: 'Where the word is in the title.' },
} as const;

// A table rule that keeps a part table beside its output rows; the tests
// that use it are refused before any title is computed.
class TitleWords extends TableRule<string, typeof word, typeof place> {
  override readonly key = { name: 'id', description: 'Note id.' };
  override readonly output = word;
  override readonly place = place;
  override readonly batch = 10;
  override readonly concurrency = 1;

  override read(row: LoadedRow) {
    return typeof row.id === 'string' && typeof row.title === 'string'
      ? { key: row.id, input: row.title }
      : null;
  }

  override async identity() {
    return 'title-words-1';
  }

  override async compute(
    titles: readonly string[],
  ): Promise<
    readonly TableRuleResult<
      RuleValues<typeof word> & RuleValues<typeof place>
    >[]
  > {
    return titles.map(() => ({ empty: true }));
  }
}

const described = { type: 'string', description: 'Note title.' } as const;

// The tables and views of the database outside the catalogs of Postgres, as
// schema.name with their kind.
async function relations(sql: postgres.Sql) {
  return (
    await sql<{ relation: string; kind: string }[]>`
      SELECT n.nspname || '.' || c.relname AS relation, c.relkind::text AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'v')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY 1`
  ).map(({ relation, kind }) => ({ relation, kind }));
}

// A login role that, as agent_reader in infra/init/marts/contract.sql, may
// use marts only and select each table and view the loader makes there.
// Roles belong to the whole server, which other tests share.
async function martsReader(sql: postgres.Sql, url: string) {
  const role = `reader_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  await sql.unsafe(`
    CREATE ROLE ${role} LOGIN PASSWORD '${password}';
    CREATE SCHEMA marts;
    GRANT USAGE ON SCHEMA marts TO ${role};
    ALTER DEFAULT PRIVILEGES IN SCHEMA marts GRANT SELECT ON TABLES TO ${role};
  `);
  const reader = new URL(url);
  reader.username = role;
  reader.password = password;
  return {
    role,
    url: reader.href,
    [Symbol.asyncDispose]: async () => {
      await sql.unsafe(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    },
  };
}

test('a table named notes makes the view marts.notes over the table _warehouse.raw_notes, in no other schema, and the catalog lists notes', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = clients.adopt(
    postgres(url, { max: 1, onnotice: () => {} }),
    (client) => client.end(),
  );
  const source = new Notes(described);
  source.messages = [note('note-1', 'Groceries')];
  const destination = new PostgresDestination({ url });

  await new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        steps: [new Copy(source.notes, destination.table('notes'))],
      }),
    ],
  }).run();

  const made = await relations(sql);
  assert.deepEqual(
    made.filter(({ relation }) => /notes/.test(relation)),
    [
      { relation: '_warehouse.raw_notes', kind: 'r' },
      { relation: 'marts.notes', kind: 'v' },
    ],
  );
  assert.deepEqual(
    [...new Set(made.map(({ relation }) => relation.split('.')[0]))],
    ['_warehouse', 'marts'],
  );
  assert.deepEqual(
    made.filter(
      ({ relation, kind }) => relation.startsWith('marts.') && kind === 'r',
    ),
    [],
  );
  assert.deepEqual(
    [...(await sql`SELECT id, title FROM marts.notes`)],
    [{ id: 'note-1', title: 'Groceries' }],
  );
  assert.deepEqual(
    [
      ...(await sql`SELECT kind, name FROM marts.catalog WHERE name LIKE '%notes%' ORDER BY name`),
    ],
    [
      { kind: 'view', name: 'notes' },
      { kind: 'column', name: 'notes.id' },
      { kind: 'column', name: 'notes.loaded_at' },
      { kind: 'column', name: 'notes.title' },
    ],
  );
});

test('a role that may use marts only reads a reader view now and as of an earlier position, and cannot read the tables of _warehouse', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = clients.adopt(
    postgres(url, { max: 1, onnotice: () => {} }),
    (client) => client.end(),
  );
  await using reader = await martsReader(sql, url);
  const source = new Notes(described);
  const destination = new PostgresDestination({ url });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url, readers: [reader.role] }),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        steps: [new Copy(source.notes, destination.table('notes'))],
      }),
    ],
  });
  source.messages = [note('note-1', 'Groceries')];
  await pipeline.run();
  const readings = new PostgresDestination({ url: reader.url });
  const [first] = await readings
    .positions()
    .then((positions) => ('expired' in positions ? [] : positions));
  assert.ok(first);
  source.messages = [note('note-2', 'Errands')];
  await pipeline.run();

  const then = await readings.reading(first);
  if ('expired' in then) assert.fail(then.expired);
  await using _then = then;
  const now = await readings.reading();
  if ('expired' in now) assert.fail(now.expired);
  await using _now = now;
  const session = clients.adopt(
    postgres(reader.url, { max: 1, onnotice: () => {} }),
    (client) => client.end(),
  );

  assert.deepEqual(
    [...(await then.sql`SELECT id, title FROM marts.notes`)],
    [{ id: 'note-1', title: 'Groceries' }],
  );
  assert.deepEqual(
    [...(await now.sql`SELECT id, title FROM marts.notes`)],
    [{ id: 'note-2', title: 'Errands' }],
  );
  await assert.rejects(
    session`SELECT id FROM _warehouse.raw_notes`,
    /permission denied for table raw_notes/,
  );
});

test('stream_status and extraction_coverage name the reader view of each copy, tell that it exists, and have no target_schema', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = clients.adopt(
    postgres(url, { max: 1, onnotice: () => {} }),
    (client) => client.end(),
  );
  const source = new Notes(described);
  source.messages = [note('note-1', 'Groceries')];
  const destination = new PostgresDestination({ url });

  await new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        steps: [new Copy(source.notes, destination.table('notes'))],
      }),
    ],
  }).run();

  assert.deepEqual(
    [...(await sql`SELECT stream, target_table FROM marts.stream_status`)],
    [{ stream: 'notes', target_table: 'notes' }],
  );
  assert.deepEqual(
    [
      ...(await sql`SELECT stream, target_table, target_exists FROM marts.extraction_coverage`),
    ],
    [{ stream: 'notes', target_table: 'notes', target_exists: true }],
  );
  assert.deepEqual(
    [
      ...(await sql`
        SELECT table_name FROM information_schema.columns
        WHERE table_schema IN ('marts', '_warehouse') AND column_name = 'target_schema'`),
    ],
    [],
  );
});

test('a copy whose stream leaves a field undescribed fails at declaration, naming the field and the stream, and makes nothing', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = clients.adopt(
    postgres(url, { max: 1, onnotice: () => {} }),
    (client) => client.end(),
  );
  const source = new Notes({ type: 'string' });
  source.messages = [note('note-1', 'Groceries')];
  const destination = new PostgresDestination({ url });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        steps: [new Copy(source.notes, destination.table('notes'))],
      }),
    ],
  });

  await assert.rejects(
    pipeline.run(),
    /^TypeError: Reader view marts\.notes needs JSON Schema descriptions for title of stream notes$/,
  );
  assert.deepEqual(
    (await relations(sql)).filter(({ relation }) => /notes/.test(relation)),
    [],
  );
});

void test.each(
  [
    'catalog',
    'sync_attempts',
    'sync_status',
    'stream_status',
    'extraction_coverage',
    'derived_status',
  ],
  (name) =>
    test(`the reader name ${name}, a relation the sync history publishes in marts, is refused`, () => {
      const destination = new PostgresDestination({
        url: 'postgres://nobody@127.0.0.1:1/none',
      });

      assert.throws(
        () => destination.table(name),
        new RegExp(
          `^TypeError: Reader name ${name} is a relation the destination makes$`,
        ),
        name,
      );
    }),
);

test('a reader name that starts with _elt_ is renamed, and a name that differs from a published relation only in case is kept', () => {
  const destination = new PostgresDestination({
    url: 'postgres://nobody@127.0.0.1:1/none',
  });

  assert.match(destination.table('_elt_notes').name, /^elt_notes_[0-9a-f]{8}$/);
  assert.equal(destination.table('Catalog').name, 'Catalog');
});

test('a view or computed dataset whose relation takes the name of a reader view or raw table of a copy is refused before the pipeline reads', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = clients.adopt(
    postgres(url, { max: 1, onnotice: () => {} }),
    (client) => client.end(),
  );
  const source = new Notes(described);
  source.messages = [note('note-1', 'Groceries')];
  const destination = new PostgresDestination({ url });
  const notes = destination.table('notes');
  const pipeline = (
    target: PostgresTable,
    derived: View | ComputedDataset<string>,
  ) =>
    new Pipeline({
      clock: globalThis,
      history: new PostgresSyncHistory({ url }),
      connections: [
        new Connection({
          name: 'notes',
          source,
          destination,
          steps: [new Copy(source.notes, target)],
        }),
      ],
      derived: [derived],
    });
  const lengths = (name: string, from: PostgresTable) =>
    new ComputedDataset({
      into: destination,
      name,
      description: 'Title lengths.',
      from: [from],
      compute: new TitleLength(),
    });
  const words = (name: string, from: PostgresTable) =>
    new ComputedDataset({
      into: destination,
      name,
      description: 'Title words.',
      from: [from],
      compute: new TitleWords(),
    });

  await assert.rejects(
    pipeline(
      notes,
      new View({
        into: destination,
        name: 'notes',
        description: 'Notes again.',
        columns: { id: 'Note id.' },
        sql: 'SELECT id FROM notes',
      }),
    ).run(),
    /^TypeError: View marts\.notes has the name of a table or reader view a copy makes$/,
  );
  await assert.rejects(
    pipeline(notes, lengths('notes', notes)).run(),
    /^TypeError: Computed dataset notes needs marts\.notes, which a copy of the pipeline makes$/,
  );
  const parts = destination.table('words_parts');
  await assert.rejects(
    pipeline(parts, words('words', parts)).run(),
    /^TypeError: Computed dataset words needs marts\.words_parts, which a copy of the pipeline makes$/,
  );
  assert.deepEqual(
    (await relations(sql)).filter(({ relation }) =>
      /notes|lengths|words/.test(relation),
    ),
    [],
  );
});
