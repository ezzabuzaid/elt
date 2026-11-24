import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

import { Connection, Copy, IterableSource, Pipeline } from '@eltjs/elt';

import { PostgresDestination, PostgresSyncHistory } from './index.ts';

const databases = new Postgres({ environment: process.env });

test('a full refresh of host rows that did not change writes no row', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const rows = [
    { name: 'a', text: 'a' },
    { name: 'b', text: 'b' },
  ];
  const source = new IterableSource({
    identity: 'tasks',
    streams: {
      tasks: {
        description: 'The tasks that the test gives.',
        jsonSchema: {
          type: 'object',
          description: 'A task.',
          properties: {
            name: { type: 'string', description: 'Name of the task.' },
            text: { type: 'string', description: 'What the task asks.' },
          },
          required: ['name', 'text'],
        },
        primaryKey: ['name'],
        deletions: 'closed-world',
        snapshot: () => rows,
      },
    },
  });
  const destination = new PostgresDestination({ url });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: [
      new Connection({
        name: 'tasks',
        source,
        destination,
        steps: [
          new Copy(source.streams.tasks, destination.table('tasks'), {
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite_dedup',
          }),
        ],
      }),
    ],
  });
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(url, { max: 1, onnotice: () => {} }),
    (session) => session.end(),
  );
  const loaded = async () =>
    [
      ...(await sql.unsafe(
        'SELECT name, text, committed_in FROM _warehouse.raw_tasks ORDER BY name',
      )),
    ].map(({ name, text, committed_in }) => ({ name, text, committed_in }));
  await pipeline.run();
  const before = await loaded();

  await pipeline.run();

  assert.equal(before.length, 2);
  assert.deepEqual(await loaded(), before);
});
