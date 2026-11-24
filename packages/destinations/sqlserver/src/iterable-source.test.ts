import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqlServer } from '@zukhruf/testing/sqlserver';

import { Connection, Copy, IterableSource, Pipeline } from '@eltjs/elt';
import { SqlServerDatabase } from '@eltjs/sdk-microsoft-sql-server';

import {
  SqlServerDestination,
  type SqlServerLogin,
  SqlServerSyncHistory,
} from './index.ts';

const sqlServer = new SqlServer({
  environment: process.env,
  image: 'mcr.microsoft.com/mssql/server:2025-latest',
});

const emulation = await SqlServer.emulation({ environment: process.env });

test(
  'a full refresh of host rows that did not change writes no row',
  { skip: emulation },
  async () => {
    await using database = await sqlServer.database();
    const login: SqlServerLogin = {
      server: database.host,
      port: database.port,
      database: database.database,
      user: database.user,
      password: database.password,
      trustServerCertificate: true,
    };
    await using admin = await new SqlServerDatabase(login).connect(globalThis);
    // The destination reads row versions (elt-sqlserver ADR 0010).
    await admin.query(
      `ALTER DATABASE [${database.database}] SET ALLOW_SNAPSHOT_ISOLATION ON; ALTER DATABASE [${database.database}] SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE`,
    );
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
    const destination = new SqlServerDestination({ login });
    const pipeline = new Pipeline({
      clock: globalThis,
      history: new SqlServerSyncHistory({ login }),
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
    const loaded = async () =>
      (
        await admin.query(
          'SELECT name, text, CONVERT(nvarchar(20), committed_in) AS committed_in FROM _warehouse.raw_tasks ORDER BY name',
        )
      ).map(({ name, text, committed_in }) => ({ name, text, committed_in }));
    await pipeline.run();
    const before = await loaded();

    await pipeline.run();

    assert.equal(before.length, 2);
    assert.deepEqual(await loaded(), before);
  },
);
