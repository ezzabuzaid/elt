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
  type FieldSchema,
  Pipeline,
  Source,
  Stream,
  type StreamSchema,
} from '@eltjs/elt';

import { PostgresDestination, PostgresSyncHistory } from './index.ts';

const databases = new Postgres({ environment: process.env });

// Notes whose schema and rows the test sets before each run.
class Notes extends Source {
  readonly identity = 'notes';
  rows: readonly object[] = [];
  #stream: Stream;
  protected catalog: Catalog;

  constructor(jsonSchema: StreamSchema) {
    super();
    this.#stream = Notes.#declare(jsonSchema);
    this.catalog = new Catalog([this.#stream]);
  }

  static #declare(jsonSchema: StreamSchema): Stream {
    return new Stream({
      name: 'notes',
      jsonSchema,
      supportedSyncModes: ['full_refresh'],
    });
  }

  get stream(): Stream {
    return this.#stream;
  }

  reshape(jsonSchema: StreamSchema): void {
    this.#stream = Notes.#declare(jsonSchema);
    this.catalog = new Catalog([this.#stream]);
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
    for (const data of this.rows) yield { stream: 'notes', data };
  }
}

const described = (properties: Record<string, FieldSchema>): StreamSchema => ({
  type: 'object',
  description: 'A note.',
  properties: Object.fromEntries(
    Object.entries(properties).map(([name, schema]) => [
      name,
      { ...schema, description: `The ${name} of the note.` },
    ]),
  ),
  required: ['id'],
});

test('a reload that swaps a table in keeps the views of others over it, their owners, comments, indexes and grants, and the grants of the table and its reader view', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = clients.adopt(
    postgres(url, { max: 1, onnotice: () => {} }),
    (client) => client.end(),
  );
  const destination = new PostgresDestination({ url });
  const source = new Notes(
    described({ id: { type: 'string' }, title: { type: 'string' } }),
  );
  const run = () =>
    new Pipeline({
      clock: globalThis,
      history: new PostgresSyncHistory({ url }),
      connections: [
        new Connection({
          name: 'notes',
          source,
          destination,
          steps: [new Copy(source.stream, destination.table('notes'))],
        }),
      ],
    }).run();
  source.rows = [{ id: '1', title: 'a' }];
  await run();
  // Roles belong to the whole server, which other tests share.
  const suffix = randomUUID().replaceAll('-', '');
  const analyst = `analyst_${suffix}`;
  const curator = `curator_${suffix}`;
  clients.defer(async () => {
    await sql.unsafe(
      `DROP SCHEMA IF EXISTS reports CASCADE; DROP OWNED BY ${analyst}, ${curator}; DROP ROLE ${analyst}, ${curator}`,
    );
  });
  await sql.unsafe(`
    CREATE ROLE ${analyst} NOLOGIN;
    CREATE ROLE ${curator} NOLOGIN;
    GRANT USAGE ON SCHEMA _warehouse, marts TO ${analyst}, ${curator};
    GRANT SELECT ON _warehouse.raw_notes TO ${analyst};
    GRANT SELECT ON marts.notes TO ${curator};
    ALTER DEFAULT PRIVILEGES IN SCHEMA marts GRANT SELECT ON TABLES TO ${analyst};
    CREATE SCHEMA reports;
    GRANT USAGE ON SCHEMA reports TO ${analyst};
    CREATE VIEW reports.titles AS SELECT id, title FROM marts.notes;
    COMMENT ON VIEW reports.titles IS 'The titles of the notes.';
    COMMENT ON COLUMN reports.titles.title IS 'The title.';
    ALTER VIEW reports.titles OWNER TO ${curator};
    GRANT SELECT ON reports.titles TO ${analyst};
    CREATE VIEW reports.loud AS SELECT upper(title) AS title FROM reports.titles;
    CREATE MATERIALIZED VIEW reports.counts AS SELECT count(*)::int AS n FROM _warehouse.raw_notes;
    CREATE INDEX counts_n ON reports.counts (n);
  `);

  source.reshape(
    described({
      id: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
    }),
  );
  source.rows = [
    { id: '1', title: 'b', body: 'x' },
    { id: '2', title: 'c', body: 'y' },
  ];
  await run();

  assert.deepEqual(
    {
      loud: [...(await sql`SELECT title FROM reports.loud ORDER BY title`)],
      counts: [...(await sql`SELECT n FROM reports.counts`)],
      shown: [...(await sql`SELECT body FROM marts.notes ORDER BY id`)],
      kept: [
        ...(await sql`
          SELECT pg_get_userbyid(c.relowner) AS owner,
            obj_description(c.oid, 'pg_class') AS description,
            col_description(c.oid, 2) AS title,
            to_regclass('reports.counts_n') IS NOT NULL AS indexed,
            has_table_privilege(${analyst}, '_warehouse.raw_notes', 'SELECT') AS raw,
            has_table_privilege(${curator}, 'marts.notes', 'SELECT') AS reader,
            has_table_privilege(${analyst}, 'reports.titles', 'SELECT') AS titles,
            has_table_privilege(${analyst}, 'marts.notes', 'SELECT') AS extra
          FROM pg_class c WHERE c.oid = 'reports.titles'::regclass`),
      ],
    },
    {
      loud: [{ title: 'B' }, { title: 'C' }],
      counts: [{ n: 2 }],
      shown: [{ body: 'x' }, { body: 'y' }],
      kept: [
        {
          owner: curator,
          description: 'The titles of the notes.',
          title: 'The title.',
          indexed: true,
          raw: true,
          reader: true,
          titles: true,
          extra: false,
        },
      ],
    },
  );
});

test('a shape change in place keeps the views of others that still fit it, and fails, naming the view, when one reads a column it drops', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = clients.adopt(
    postgres(url, { max: 1, onnotice: () => {} }),
    (client) => client.end(),
  );
  const destination = new PostgresDestination({ url });
  const source = new Notes(
    described({
      id: { type: 'string' },
      title: { type: 'string' },
      score: { type: 'integer' },
    }),
  );
  const run = () =>
    new Pipeline({
      clock: globalThis,
      history: new PostgresSyncHistory({ url }),
      connections: [
        new Connection({
          name: 'notes',
          source,
          destination,
          steps: [
            new Copy(source.stream, destination.table('notes'), {
              syncMode: 'full_refresh',
              destinationSyncMode: 'append',
            }),
          ],
        }),
      ],
    }).run();
  source.rows = [{ id: '1', title: 'a', score: 2 }];
  await run();
  await sql.unsafe(`
    CREATE SCHEMA reports;
    CREATE VIEW reports.scores AS SELECT id, score FROM _warehouse.raw_notes;
    CREATE VIEW reports.titles AS SELECT title FROM marts.notes;
  `);

  source.reshape(
    described({
      id: { type: 'string' },
      title: { type: 'string' },
      score: { type: 'number' },
    }),
  );
  source.rows = [{ id: '2', title: 'b', score: 2.5 }];
  await run();
  const widened = {
    scores: [...(await sql`SELECT id, score FROM reports.scores ORDER BY id`)],
    titles: [...(await sql`SELECT title FROM reports.titles ORDER BY title`)],
  };

  source.reshape(
    described({ id: { type: 'string' }, score: { type: 'number' } }),
  );
  source.rows = [{ id: '3', score: 1 }];
  await assert.rejects(
    run(),
    /reports\.titles reads "_warehouse"\."raw_notes" and does not fit its change: column "?title"? does not exist/,
  );

  assert.deepEqual(
    {
      widened,
      kept: [...(await sql`SELECT title FROM reports.titles ORDER BY title`)],
    },
    {
      widened: {
        scores: [
          { id: '1', score: 2 },
          { id: '2', score: 2.5 },
        ],
        titles: [{ title: 'a' }, { title: 'b' }],
      },
      kept: [{ title: 'a' }, { title: 'b' }],
    },
  );
});
