import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { inspect } from 'node:util';

import { SQL_SERVER_FULL_IMAGE, SqlServer } from '@zukhruf/testing/sqlserver';
import sql from 'mssql';

import { SqlServerDatabase, SqlServerUnavailableError } from './index.ts';

const sqlServer = new SqlServer({
  environment: process.env,
  image: SQL_SERVER_FULL_IMAGE,
});

test('a connection keeps one session from one statement to the next, also past a statement that fails: its #temp table, its session context and a transaction that spans statements', async () => {
  await using scratch = await sqlServer.database();
  const database = new SqlServerDatabase({
    server: scratch.host,
    port: scratch.port,
    database: scratch.database,
    user: scratch.user,
    password: scratch.password,
    trustServerCertificate: true,
  });
  await using connection = await database.connect();

  const [first] = await connection.query(
    'CREATE TABLE #notes (note nvarchar(max) NULL); SELECT @@SPID AS spid',
  );
  await connection.query(
    "DECLARE @kept nvarchar(20) = @value; EXEC sp_set_session_context @key = N'elt.test', @value = @kept",
    { value: 'kept' },
  );
  await connection.query('BEGIN TRANSACTION');
  await connection.query('INSERT INTO #notes (note) VALUES (@note), (@none)', {
    note: 'ü 😀',
    none: null,
  });
  const during = await connection.query(
    'SELECT note, @@TRANCOUNT AS open_transactions FROM #notes ORDER BY note',
  );
  await connection.query('ROLLBACK');
  const refused = await connection
    .query('SELECT CAST(@text AS int) AS n', { text: 'not a number' })
    .then(
      () => assert.fail('the cast succeeded'),
      (error: unknown) => error,
    );
  const [last] = await connection.query(
    "SELECT @@SPID AS spid, CAST(SESSION_CONTEXT(N'elt.test') AS nvarchar(20)) AS context, (SELECT COUNT(*) FROM #notes) AS notes",
  );

  assert.deepEqual(during, [
    { note: null, open_transactions: 1 },
    { note: 'ü 😀', open_transactions: 1 },
  ]);
  assert.match(String(refused), /Conversion failed/);
  assert.deepEqual(last, { spid: first?.spid, context: 'kept', notes: 0 });
});

test('a connection whose session the server ends tells its owner, and never connects again', async () => {
  await using scratch = await sqlServer.database();
  await using clients = new AsyncDisposableStack();
  const admin = clients.adopt(
    new sql.ConnectionPool(scratch.connectionString),
    (pool) => pool.close(),
  );
  await admin.connect();
  const database = new SqlServerDatabase({
    server: scratch.host,
    port: scratch.port,
    database: scratch.database,
    user: scratch.user,
    password: scratch.password,
    trustServerCertificate: true,
  });
  await using connection = await database.connect();
  const [session] = await connection.query('SELECT @@SPID AS spid');
  const ended = once(connection, 'end');

  await admin.request().batch(`KILL ${Number(session?.spid)}`);
  await ended;
  const after = await connection.query('SELECT 1 AS one').then(
    () => assert.fail('the connection connected again'),
    (error: unknown) => error,
  );

  assert.ok(after instanceof SqlServerUnavailableError, inspect(after));
  assert.equal(
    Error.isError(after.cause) ? after.cause.message : after.cause,
    'The session of this connection ended',
  );
});
