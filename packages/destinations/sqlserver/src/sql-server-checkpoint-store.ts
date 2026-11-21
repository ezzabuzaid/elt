import { Modes, Mutex } from '@zukhruf/mutex';
import { SqlServerStore } from '@zukhruf/mutex/sqlserver';

import {
  type CheckpointSession,
  CheckpointStore,
  type FailureType,
} from '@eltjs/elt';
import {
  type SqlServerConnection,
  SqlServerDatabase,
} from '@eltjs/sdk-microsoft-sql-server';

import {
  type SqlServerLogin,
  connect,
  takeLock,
  transaction,
} from './sql-server-connection.ts';
import { failureType } from './sql-server-failure-type.ts';
import { quote } from './sql-server-identifiers.ts';
import { inWarehouse, warehouse } from './sql-server-schemas.ts';

// The checkpoints of every copy into the database, beside the data they
// describe, by the id of the copy. Each acknowledged checkpoint is saved as
// soon as the load commits it; a crash in between replays that unit. The id
// is unique by its SHA-256, as a key of any length is (ADR 0004), and keeps
// each UTF-16 code unit, as binding and state do: the JSON type would refuse
// \u0000 and lone surrogates.
const table = inWarehouse('_elt_checkpoints');
// The fencing tokens of the locks of the copies.
const tokens = inWarehouse('_elt_checkpoint_tokens');

export class SqlServerCheckpointStore extends CheckpointStore {
  readonly #database: SqlServerDatabase;
  // One key for each copy id, on a session of its own (ADR 0009). The server
  // releases a key when the session that holds it ends. The heartbeat runs
  // on real time, as no caller has another correct value.
  readonly #locks: Mutex;

  constructor({ login }: { login: SqlServerLogin }) {
    super();
    const database = new SqlServerDatabase(login);
    this.#database = database;
    this.#locks = new Mutex(
      new SqlServerStore({
        connect: () => database.connect(),
        sequence: tokens,
        heartbeatInterval: 10_000,
        clock: globalThis,
      }),
    );
    Object.freeze(this);
  }

  override failureType(error: unknown): FailureType {
    return failureType(error);
  }

  protected override async session<T>(
    ids: readonly string[],
    work: (session: CheckpointSession) => Promise<T>,
  ): Promise<T> {
    await using connection = await connect(this.#database);
    await create(connection);
    return await this.#held(ids, () => withTable(connection, work));
  }

  // Holds each copy's key in turn, then works. A copy already running fails
  // the run fast; others run in parallel.
  async #held<T>(ids: readonly string[], work: () => Promise<T>): Promise<T> {
    const [id, ...rest] = ids;
    if (id === undefined) return await work();
    const held = await this.#locks.acquire(id, () => this.#held(rest, work), {
      mode: Modes.skipIfBusy(),
    });
    if (!held.acquired)
      throw new TypeError(`Checkpoint ${id} is in use by another run`);
    return held.value;
  }
}

// Each save commits on its own, so it is durable when it resolves.
function withTable<T>(
  connection: SqlServerConnection,
  work: (session: CheckpointSession) => Promise<T>,
): Promise<T> {
  return work({
    read: async (id) => {
      const [saved] = await connection.query(
        `SELECT [binding], [reloading] FROM ${table} WHERE [key] = HASHBYTES('SHA2_256', @id)`,
        { id },
      );
      return saved === undefined
        ? undefined
        : {
            binding: String(saved.binding),
            reloading: saved.reloading === true,
          };
    },
    state: async (id) => {
      const [saved] = await connection.query(
        `SELECT [state] FROM ${table} WHERE [key] = HASHBYTES('SHA2_256', @id)`,
        { id },
      );
      return saved === undefined ? undefined : String(saved.state);
    },
    save: async (id, { binding, reloading, state }) => {
      await connection.query(
        `UPDATE ${table} SET [binding] = @binding, [reloading] = CAST(@reloading AS bit), [state] = @state WHERE [key] = HASHBYTES('SHA2_256', @id);
         IF @@ROWCOUNT = 0
           INSERT INTO ${table} ([id], [binding], [reloading], [state]) VALUES (@id, @binding, CAST(@reloading AS bit), @state);`,
        { id, binding, reloading: reloading ? '1' : '0', state },
      );
    },
    reloaded: async (id) => {
      await connection.query(
        `UPDATE ${table} SET [reloading] = 0 WHERE [key] = HASHBYTES('SHA2_256', @id)`,
        { id },
      );
    },
    remove: async (id) => {
      await connection.query(
        `DELETE FROM ${table} WHERE [key] = HASHBYTES('SHA2_256', @id)`,
        { id },
      );
    },
  });
}

// Two runs make the table at once, and SQL Server refuses the second CREATE;
// the lock of _warehouse makes them take turns.
async function create(connection: SqlServerConnection): Promise<void> {
  const [found] = await connection.query(
    `SELECT IIF(OBJECT_ID(N'${table}', N'U') IS NULL OR OBJECT_ID(N'${tokens}', N'SO') IS NULL, 0, 1) AS [made]`,
  );
  if (found?.made === 1) return;
  await transaction(connection, async () => {
    await takeLock(connection, warehouse);
    await connection.query(
      `IF SCHEMA_ID(N'${warehouse}') IS NULL EXEC (N'CREATE SCHEMA ${quote(warehouse)}');
       IF OBJECT_ID(N'${table}', N'U') IS NULL
         CREATE TABLE ${table} ([id] nvarchar(max) NOT NULL, [key] AS CAST(HASHBYTES('SHA2_256', [id]) AS binary(32)) PERSISTED NOT NULL PRIMARY KEY, [binding] nvarchar(max) NOT NULL, [reloading] bit NOT NULL, [state] nvarchar(max) NOT NULL);
       IF OBJECT_ID(N'${tokens}', N'SO') IS NULL
         EXEC (N'CREATE SEQUENCE ${tokens} AS bigint START WITH 1');`,
    );
  });
}
