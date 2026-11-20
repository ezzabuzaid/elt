import { hash } from 'node:crypto';

import {
  type Connection,
  type CopyOutcome,
  type DeclaredCopy,
  type FailureType,
  type RecordedPass,
  type StreamCheck,
  SyncHistory,
  copyStatus,
  errorMessage,
  passError,
  passFailureType,
  passStatus,
  recordedFailure,
} from '@eltjs/elt';
import {
  type SqlServerConnection,
  SqlServerDatabase,
} from '@eltjs/sdk-microsoft-sql-server';

import {
  type SqlServerLogin,
  connect,
  lockSchema,
  transaction,
} from './sql-server-connection.ts';
import { SqlServerDestination } from './sql-server-destination.ts';
import {
  databaseCopy,
  grantReading,
  installNumbering,
} from './sql-server-numbering.ts';
import { warehouse } from './sql-server-schemas.ts';
import {
  attempts,
  catalog,
  checks,
  coverage,
  syncHistoryTables,
  syncHistoryViews,
} from './sql-server-sync-history-schema.ts';
import type { SqlServerTable } from './sql-server-table.ts';
import { publishViews } from './sql-server-views.ts';

// Records every pass in the _warehouse schema, and shows readers that history
// and the catalog through views in marts, as in elt-postgresql. readers are
// the database users or roles that read the database as of a position with
// their own session: each install grants them the numbering, and nothing
// else of _warehouse.
export class SqlServerSyncHistory extends SyncHistory<SqlServerTable> {
  readonly #database: SqlServerDatabase;
  readonly #readers: readonly string[];

  constructor({
    login,
    readers = [],
  }: {
    login: SqlServerLogin;
    readers?: readonly string[];
  }) {
    super();
    this.#database = new SqlServerDatabase(login);
    this.#readers = Object.freeze(
      readers.map((reader) => {
        if (typeof reader !== 'string' || !reader || reader.length > 128)
          throw new TypeError(`Invalid reader: ${JSON.stringify(reader)}`);
        return reader;
      }),
    );
    Object.freeze(this);
  }

  override validate({ name, destination }: Connection<SqlServerTable>): void {
    if (!(destination instanceof SqlServerDestination))
      throw new TypeError(
        `Connection ${name}: SQL Server sync history records SQL Server destinations only`,
      );
  }

  protected override async recordChecks(
    connection: Connection<SqlServerTable>,
    streamChecks: readonly StreamCheck[],
  ): Promise<void> {
    await using session = await connect(this.#database);
    await transaction(session, async () => {
      for (const { stream, at } of streamChecks)
        await session.query(
          `UPDATE ${checks} SET [checked_at] = CAST(@at AS datetimeoffset(3)) WHERE [connector] = @connector AND [stream] = @stream;
           IF @@ROWCOUNT = 0
             INSERT INTO ${checks} ([connector], [stream], [checked_at]) VALUES (@connector, @stream, CAST(@at AS datetimeoffset(3)));`,
          { connector: connection.name, stream, at: at.toISOString() },
        );
    });
  }

  // Every selected stream is declared before reading, even if it produces no
  // rows or the process dies. The pass's own session holds an application
  // lock on its attempt until the pipeline disposes the pass, and the server
  // lets go of the locks of a session that ends, also of a killed process.
  // So an attempt of the connection that runs while no session holds its lock
  // will get no outcome, and the next attempt records it as failed (ADR
  // 0009).
  override async begin(
    connection: Connection<SqlServerTable>,
    copies: readonly DeclaredCopy<SqlServerTable>[],
    at: Date,
  ): Promise<RecordedPass<SqlServerTable>> {
    const session = await connect(this.#database);
    try {
      const id = await transaction(session, async () => {
        await failEnded(session, connection.name, at);
        const [attempt] = await session.query(
          `INSERT INTO ${attempts} ([connector], [source], [started_at]) OUTPUT CONVERT(nvarchar(20), inserted.[id]) AS [id] VALUES (@connector, @source, CAST(@at AS datetimeoffset(3)))`,
          {
            connector: connection.name,
            source: connection.source.identity,
            at: at.toISOString(),
          },
        );
        if (typeof attempt?.id !== 'string')
          throw new Error('Sync attempt was not recorded');
        // A lock of the session outlives the transaction, so no reader sees
        // the attempt before its lock is held.
        await session.query(
          `DECLARE @result int;
           EXEC @result = sp_getapplock @Resource = @resource, @LockMode = N'Exclusive', @LockOwner = N'Session', @LockTimeout = 0;
           IF @result < 0 THROW 50000, N'The lock of the attempt was not granted', 1;`,
          { resource: attemptLock(attempt.id) },
        );
        for (const { copy, coverage: covered } of copies)
          await session.query(
            `INSERT INTO ${coverage} ([attempt_id], [stream], [target_table], [sync_mode], [destination_sync_mode], [description], [selection])
             VALUES (CAST(@attempt AS bigint), @stream, @target, @syncMode, @destinationSyncMode, @description, CAST(@selection AS json))`,
            {
              attempt: attempt.id,
              stream: copy.from.name,
              target: copy.to.name,
              syncMode: copy.configuration.syncMode,
              destinationSyncMode: copy.configuration.destinationSyncMode,
              description: covered.description,
              selection: JSON.stringify(covered.selection),
            },
          );
        return attempt.id;
      });
      return {
        finish: async (outcomes, upstream, ended) => {
          await transaction(session, () =>
            finish(session, id, outcomes, upstream, ended),
          );
        },
        fail: async (error, failureType, ended) => {
          await transaction(session, () =>
            fail(session, [id], error, failureType, ended),
          );
        },
        [Symbol.asyncDispose]: () => session[Symbol.asyncDispose](),
      };
    } catch (error) {
      await session[Symbol.asyncDispose]();
      throw error;
    }
  }

  // Makes the history's tables, publishes its views and the catalog, and
  // grants each reader the numbering; safe to repeat.
  override async install(): Promise<void> {
    await using session = await connect(this.#database);
    if (this.#readers.length > 0)
      await installNumbering(session, await databaseCopy(session));
    await transaction(session, async () => {
      // The numbering of the destinations makes _warehouse too, under the
      // same lock.
      await lockSchema(session, warehouse);
      await session.query(syncHistoryTables);
      await publishViews(session, [...syncHistoryViews, catalog]);
      for (const reader of this.#readers) await grantReading(session, reader);
    });
  }
}

// The application lock of an attempt, named by its hash, as sp_getapplock
// keeps 255 characters of a name.
const attemptLock = (id: string) =>
  `elt-attempt-${hash('sha256', `elt:sync-attempt:${id}`).slice(0, 32)}`;

// Records as failed each attempt of connector that runs while no session
// holds its lock: the session that ran it ended first, so no outcome will
// come. Only the server knows which sessions live, so a try of each lock is
// the test, and the lock it takes ends with the transaction.
async function failEnded(
  session: SqlServerConnection,
  connector: string,
  at: Date,
): Promise<void> {
  const running = await session.query(
    `SELECT CONVERT(nvarchar(20), [id]) AS [id] FROM ${attempts} WHERE [connector] = @connector AND [status] = N'running'`,
    { connector },
  );
  const ended: string[] = [];
  for (const { id } of running) {
    const [lock] = await session.query(
      `DECLARE @result int;
       EXEC @result = sp_getapplock @Resource = @resource, @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = 0;
       SELECT @result AS [result];`,
      { resource: attemptLock(String(id)) },
    );
    if (typeof lock?.result === 'number' && lock.result >= 0)
      ended.push(String(id));
  }
  if (ended.length > 0)
    await fail(
      session,
      ended,
      new Error(
        'The session running this pass ended before the pass did: its process stopped, or lost the database',
      ),
      'system',
      at,
    );
}

// Attempts that produced no outcomes, so what they committed is unknown.
async function fail(
  session: SqlServerConnection,
  ids: readonly string[],
  error: unknown,
  failureType: FailureType,
  at: Date,
): Promise<void> {
  await session.query(
    `UPDATE ${coverage} SET [status] = N'failed', [failures] = CAST(@failures AS json)
     WHERE [attempt_id] IN (SELECT CAST([value] AS bigint) FROM OPENJSON(@ids));
     UPDATE ${attempts} SET [status] = N'failed', [completed_at] = CAST(@at AS datetimeoffset(3)), [error] = @error, [failure_type] = @failureType
     WHERE [id] IN (SELECT CAST([value] AS bigint) FROM OPENJSON(@ids));`,
    {
      ids: JSON.stringify(ids),
      failures: JSON.stringify([
        recordedFailure({ partition: null, error, failureType }),
      ]),
      at: at.toISOString(),
      error: errorMessage(error),
      failureType,
    },
  );
}

async function finish(
  session: SqlServerConnection,
  id: string,
  outcomes: readonly CopyOutcome<SqlServerTable>[],
  upstream: ReadonlyMap<string, Date>,
  ended: Date,
): Promise<void> {
  for (const outcome of outcomes)
    await session.query(
      `UPDATE ${coverage} SET [status] = @status, [written_count] = CAST(@written AS bigint), [deleted_count] = CAST(@deleted AS bigint), [failures] = CAST(@failures AS json)
       WHERE [attempt_id] = CAST(@attempt AS bigint) AND [stream] = @stream`,
      {
        status: copyStatus(outcome),
        written: String(outcome.count),
        deleted: String(outcome.deleted),
        failures: JSON.stringify(outcome.failures.map(recordedFailure)),
        attempt: id,
        stream: outcome.copy.from.name,
      },
    );
  for (const [stream, at] of upstream)
    await session.query(
      `UPDATE ${coverage} SET [upstream_current_as_of] = CAST(@at AS datetimeoffset(3)) WHERE [attempt_id] = CAST(@attempt AS bigint) AND [stream] = @stream`,
      { at: at.toISOString(), attempt: id, stream },
    );
  await session.query(
    `UPDATE ${attempts} SET [completed_at] = CAST(@ended AS datetimeoffset(3)), [status] = @status, [error] = @error, [failure_type] = @failureType WHERE [id] = CAST(@attempt AS bigint)`,
    {
      ended: ended.toISOString(),
      status: passStatus(outcomes),
      error: passError(outcomes),
      failureType: passFailureType(outcomes),
      attempt: id,
    },
  );
}
