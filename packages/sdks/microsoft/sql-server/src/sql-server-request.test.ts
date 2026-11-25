import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type Socket, connect, createServer } from 'node:net';
import { test } from 'node:test';
import { inspect } from 'node:util';

import { waitFor } from '@zukhruf/testing/async';
import {
  type Database,
  SQL_SERVER_FULL_IMAGE,
  SqlServer,
} from '@zukhruf/testing/sqlserver';
import sql from 'mssql';

import { SqlServerDatabase, SqlServerUnavailableError } from './index.ts';

const sqlServer = new SqlServer({
  environment: process.env,
  image: SQL_SERVER_FULL_IMAGE,
});

// How long the driver waits for SQL Server to acknowledge a cancel before it
// ends the connection: tedious's cancelTimeout, which this package leaves at
// its default.
const CANCEL_WAIT_MS = 5_000;

// A TCP hop to the server that can stop forwarding what the server sends
// while both sockets stay open, as a stalled server or network does. It is a
// stand-in because the test cannot make the shared server leave a cancel
// unacknowledged. After the login the stream is TLS, so the hop cannot see
// the cancel itself (a TDS attention): it stops at a count of the server's
// bytes. A copy of the hop of @eltjs/source-microsoft-sql-server
// (docs/copied-from-source-microsoft-sql-server.md).
async function relay(database: Database) {
  const sockets = new Set<Socket>();
  const links = new Map<Socket, Socket>();
  // The bytes that the client sent through the hop.
  const hop = { sent: 0 };
  let stalling: { left: number; reached: (sent: number) => void } | undefined;
  const server = createServer((client) => {
    const upstream = connect(database.port, database.host);
    links.set(upstream, client);
    upstream.on('close', () => links.delete(upstream));
    for (const [socket, other] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      sockets.add(socket);
      socket.pipe(other);
      socket.on('error', () => other.destroy());
      socket.on('close', () => {
        sockets.delete(socket);
        other.destroy();
      });
    }
    client.on('data', (chunk) => {
      hop.sent += chunk.length;
    });
    // After the pipe, so the chunk that reaches the count still goes to the
    // client, and only what the server sends after it is held.
    upstream.on('data', (chunk) => {
      if (stalling === undefined) return;
      stalling.left -= chunk.length;
      if (stalling.left > 0) return;
      const { reached } = stalling;
      stalling = undefined;
      for (const [from, to] of links) {
        from.unpipe(to);
        from.pause();
      }
      reached(hop.sent);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return Object.assign(hop, {
    port: address.port,
    // Settles, with the bytes that the client had sent by then, once the
    // server sent that many more bytes, which the hop forwards; it holds all
    // that the server sends on its open connections after them. A connection
    // opened later is forwarded.
    stallAfter: (bytes: number) =>
      new Promise<number>((reached) => {
        stalling = { left: bytes, reached };
      }),
    [Symbol.asyncDispose]: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  });
}

test("a batch whose cancel SQL Server never acknowledges rejects with its signal's reason once the driver stops waiting, and the connection then tells its owner that its session ended", async () => {
  await using scratch = await sqlServer.database();
  await using hop = await relay(scratch);
  const database = new SqlServerDatabase({
    server: '127.0.0.1',
    port: hop.port,
    database: scratch.database,
    user: scratch.user,
    password: scratch.password,
    trustServerCertificate: true,
  });
  await using connection = await database.connect(globalThis);
  const ended = once(connection, 'end');
  const stop = new AbortController();
  const reason = new Error('the model ran out of time');
  // The message is the first thing that the server sends for the batch, and
  // it sends nothing more for a minute: the hop forwards the message and
  // holds what follows, the acknowledgement of the cancel.
  const held = hop.stallAfter(1);
  const batch = connection
    .query(
      "RAISERROR('started', 0, 1) WITH NOWAIT; WAITFOR DELAY '00:01:00'; SELECT 1 AS late",
      {},
      { signal: stop.signal },
    )
    .then(
      () => assert.fail('the batch ran to its end'),
      (error: unknown) => error,
    );

  await held;
  const aborted = performance.now();
  stop.abort(reason);
  const stopped = await batch;
  const waited = performance.now() - aborted;
  await ended;
  const after = await connection.query('SELECT 1 AS one').then(
    () => assert.fail('the connection connected again'),
    (error: unknown) => error,
  );

  assert.equal(stopped, reason);
  // Less a margin, as a timer may fire a moment early.
  assert.ok(
    waited >= CANCEL_WAIT_MS - 100,
    `settled ${Math.round(waited)} ms after the abort`,
  );
  assert.ok(after instanceof SqlServerUnavailableError, inspect(after));
  assert.equal(
    Error.isError(after.cause) ? after.cause.message : after.cause,
    'The session of this connection ended',
  );
});

test("a gauge query of a session whose cancel SQL Server never acknowledges rejects with its signal's reason, and the session's next query answers", async (t) => {
  await using scratch = await sqlServer.database();
  await using clients = new AsyncDisposableStack();
  const admin = clients.adopt(
    new sql.ConnectionPool(scratch.connectionString),
    (pool) => pool.close(),
  );
  await admin.connect();
  await admin
    .request()
    .batch(
      "CREATE TABLE dbo.notes (note nvarchar(max) NULL); INSERT INTO dbo.notes (note) VALUES (N'one'), (N'two')",
    );
  await using hop = await relay(scratch);
  const database = new SqlServerDatabase({
    server: '127.0.0.1',
    port: hop.port,
    database: scratch.database,
    user: scratch.user,
    password: scratch.password,
    trustServerCertificate: true,
  });
  await using session = await database.open();
  const stop = new AbortController();
  const reason = new Error('the check ran out of time');
  // Before the pool lends its connection, it checks it with a SELECT 1. The
  // hop forwards the answer to that check and holds what follows: the rows of
  // the gauge and the acknowledgement of the cancel.
  const held = hop.stallAfter(1);
  const gauge = session.rowCounts({ signal: stop.signal }).then(
    () => assert.fail('the gauge answered'),
    (error: unknown) => error,
  );

  const sent = await held;
  await waitFor(
    () => assert.ok(hop.sent > sent, 'the gauge reached the server'),
    { signal: t.signal },
  );
  stop.abort(reason);
  const stopped = await gauge;
  const counts = await session.rowCounts();

  assert.equal(stopped, reason);
  assert.deepEqual(counts, new Map([['[dbo].[notes]', '2']]));
});
