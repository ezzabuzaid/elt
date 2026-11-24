import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

import {
  Connection,
  Copy,
  type FieldSchema,
  IterableSource,
  Pipeline,
  type StreamSchema,
} from '@eltjs/elt';

import { PostgresDestination, PostgresSyncHistory } from './index.ts';

const databases = new Postgres({ environment: process.env });

// Notes of this schema and these rows, copied in full each pass. A test that
// reshapes the notes makes a new source with the same identity.
const notesOf = (
  jsonSchema: StreamSchema,
  rows: readonly Record<string, unknown>[],
) =>
  new IterableSource({
    identity: 'notes',
    streams: {
      notes: {
        description: 'The notes that the test sets.',
        jsonSchema,
        primaryKey: ['id'],
        snapshot: () => rows,
      },
    },
  });

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
  let source = notesOf(
    described({ id: { type: 'string' }, title: { type: 'string' } }),
    [{ id: '1', title: 'a' }],
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
          steps: [new Copy(source.streams.notes, destination.table('notes'))],
        }),
      ],
    }).run();
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

  source = notesOf(
    described({
      id: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
    }),
    [
      { id: '1', title: 'b', body: 'x' },
      { id: '2', title: 'c', body: 'y' },
    ],
  );
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
  let source = notesOf(
    described({
      id: { type: 'string' },
      title: { type: 'string' },
      score: { type: 'integer' },
    }),
    [{ id: '1', title: 'a', score: 2 }],
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
            new Copy(source.streams.notes, destination.table('notes'), {
              syncMode: 'full_refresh',
              destinationSyncMode: 'append',
            }),
          ],
        }),
      ],
    }).run();
  await run();
  await sql.unsafe(`
    CREATE SCHEMA reports;
    CREATE VIEW reports.scores AS SELECT id, score FROM _warehouse.raw_notes;
    CREATE VIEW reports.titles AS SELECT title FROM marts.notes;
  `);

  source = notesOf(
    described({
      id: { type: 'string' },
      title: { type: 'string' },
      score: { type: 'number' },
    }),
    [{ id: '2', title: 'b', score: 2.5 }],
  );
  await run();
  const widened = {
    scores: [...(await sql`SELECT id, score FROM reports.scores ORDER BY id`)],
    titles: [...(await sql`SELECT title FROM reports.titles ORDER BY title`)],
  };

  source = notesOf(
    described({ id: { type: 'string' }, score: { type: 'number' } }),
    [{ id: '3', score: 1 }],
  );
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
