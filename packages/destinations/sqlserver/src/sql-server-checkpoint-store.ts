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
// The keyed entries of each checkpoint, by space (ADR 0035 of elt), unique by
// the SHA-256 of each part of their key, as the checkpoints are.
const entriesTable = inWarehouse('_elt_checkpoint_entries');
// The entries of a save, as an nvarchar(max) JSON array of [space, key] or
// [space, key, value] rows that OPENJSON reads in one statement; value is the
// entry's JSON text, as a string.
const entryRows = `OPENJSON(@entries) WITH ([space] nvarchar(max) '$[0]', [key] nvarchar(max) '$[1]', [value] nvarchar(max) '$[2]') AS j`;
const ofEntry = `[id_hash] = HASHBYTES('SHA2_256', @id) AND [space_hash] = HASHBYTES('SHA2_256', j.[space]) AND [key_hash] = HASHBYTES('SHA2_256', j.[key])`;
// The fencing tokens of the leases of the copies.
const tokens = inWarehouse('_elt_checkpoint_tokens');
// The lease of each copy id, one row each, that SqlServerStore of
// @zukhruf/mutex/sqlserver grants and renews.
const leases = inWarehouse('_elt_checkpoint_leases');

export class SqlServerCheckpointStore extends CheckpointStore {
  readonly #database: SqlServerDatabase;

  constructor({ login }: { login: SqlServerLogin }) {
    super();
    this.#database = new SqlServerDatabase(login);
    Object.freeze(this);
  }

  override failureType(error: unknown): FailureType {
    return failureType(error);
  }

  protected override async session<T>(
    ids: readonly string[],
    work: (session: CheckpointSession) => Promise<T>,
  ): Promise<T> {
    await using connection = await connect(this.#database, globalThis);
    await create(connection);
    // A lease for each copy id (ADR 0009), which the run renews every 10 s
    // on the connections of a pool of its own, so a renewal logs in only when
    // the pool has no idle connection. The heartbeat runs on real time, as no
    // caller has another correct value.
    await using pool = await this.#database.pool();
    const locks = new Mutex(
      new SqlServerStore({
        connect: () => pool.connect(),
        table: leases,
        sequence: tokens,
        heartbeatInterval: 10_000,
        clock: globalThis,
      }),
    );
    return await held(locks, ids, () => withTable(connection, work));
  }
}

// Holds each copy's key in turn, then works. A copy already running fails the
// run fast; others run in parallel.
async function held<T>(
  locks: Mutex,
  ids: readonly string[],
  work: () => Promise<T>,
): Promise<T> {
  const [id, ...rest] = ids;
  if (id === undefined) return await work();
  const lease = await locks.acquire(id, () => held(locks, rest, work), {
    mode: Modes.skipIfBusy(),
  });
  if (!lease.acquired)
    throw new TypeError(`Checkpoint ${id} is in use by another run`);
  return lease.value;
}

// Each save commits in a transaction of its own, so it is durable when it
// resolves.
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
    entries: async (id, space) =>
      (
        await connection.query(
          `SELECT [key], [value] FROM ${entriesTable} WHERE [id_hash] = HASHBYTES('SHA2_256', @id) AND [space_hash] = HASHBYTES('SHA2_256', @space)`,
          { id, space },
        )
      ).map(({ key, value }): [string, string] => [String(key), String(value)]),
    save: async (id, { binding, reloading, state, entries }) => {
      await transaction(connection, async () => {
        await connection.query(
          `UPDATE ${table} SET [binding] = @binding, [reloading] = CAST(@reloading AS bit), [state] = @state WHERE [key] = HASHBYTES('SHA2_256', @id);
           IF @@ROWCOUNT = 0
             INSERT INTO ${table} ([id], [binding], [reloading], [state]) VALUES (@id, @binding, CAST(@reloading AS bit), @state);`,
          { id, binding, reloading: reloading ? '1' : '0', state },
        );
        // A put replaces the entry of its key: the removes and the puts'
        // keys go first.
        if (entries.kind === 'replace')
          await connection.query(
            `DELETE FROM ${entriesTable} WHERE [id_hash] = HASHBYTES('SHA2_256', @id)`,
            { id },
          );
        else {
          // A scope begins a space when their bytes do, whatever the
          // collation of the column says.
          if (entries.clear.length > 0)
            await connection.query(
              `DELETE FROM ${entriesTable} WHERE [id_hash] = HASHBYTES('SHA2_256', @id) AND EXISTS (SELECT 1 FROM OPENJSON(@clear) WITH ([scope] nvarchar(max) '$') AS c WHERE SUBSTRING(CAST([space] AS varbinary(max)), 1, DATALENGTH(c.[scope])) = CAST(c.[scope] AS varbinary(max)))`,
              { id, clear: JSON.stringify(entries.clear) },
            );
          if (entries.remove.length + entries.put.length > 0)
            await connection.query(
              `DELETE FROM ${entriesTable} WHERE EXISTS (SELECT 1 FROM ${entryRows} WHERE ${ofEntry})`,
              {
                id,
                entries: JSON.stringify(
                  [...entries.remove, ...entries.put].map(({ space, key }) => [
                    space,
                    key,
                  ]),
                ),
              },
            );
        }
        if (entries.put.length > 0)
          await connection.query(
            `INSERT INTO ${entriesTable} ([id], [space], [key], [value]) SELECT @id, j.[space], j.[key], j.[value] FROM ${entryRows}`,
            {
              id,
              entries: JSON.stringify(
                entries.put.map(({ space, key, value }) => [space, key, value]),
              ),
            },
          );
      });
    },
    reloaded: async (id) => {
      await connection.query(
        `UPDATE ${table} SET [reloading] = 0 WHERE [key] = HASHBYTES('SHA2_256', @id)`,
        { id },
      );
    },
    remove: async (id) => {
      await transaction(connection, () =>
        connection.query(
          `DELETE FROM ${entriesTable} WHERE [id_hash] = HASHBYTES('SHA2_256', @id);
           DELETE FROM ${table} WHERE [key] = HASHBYTES('SHA2_256', @id);`,
          { id },
        ),
      );
    },
  });
}

// Two runs make the table at once, and SQL Server refuses the second CREATE;
// the lock of _warehouse makes them take turns.
async function create(connection: SqlServerConnection): Promise<void> {
  const [found] = await connection.query(
    `SELECT IIF(OBJECT_ID(N'${table}', N'U') IS NULL OR OBJECT_ID(N'${entriesTable}', N'U') IS NULL OR OBJECT_ID(N'${leases}', N'U') IS NULL OR OBJECT_ID(N'${tokens}', N'SO') IS NULL, 0, 1) AS [made]`,
  );
  if (found?.made === 1) return;
  await transaction(connection, async () => {
    await takeLock(connection, warehouse);
    await connection.query(
      `IF SCHEMA_ID(N'${warehouse}') IS NULL EXEC (N'CREATE SCHEMA ${quote(warehouse)}');
       IF OBJECT_ID(N'${table}', N'U') IS NULL
         CREATE TABLE ${table} ([id] nvarchar(max) NOT NULL, [key] AS CAST(HASHBYTES('SHA2_256', [id]) AS binary(32)) PERSISTED NOT NULL PRIMARY KEY, [binding] nvarchar(max) NOT NULL, [reloading] bit NOT NULL, [state] nvarchar(max) NOT NULL);
       IF OBJECT_ID(N'${entriesTable}', N'U') IS NULL
         CREATE TABLE ${entriesTable} ([id] nvarchar(max) NOT NULL, [space] nvarchar(max) NOT NULL, [key] nvarchar(max) NOT NULL, [value] nvarchar(max) NOT NULL, [id_hash] AS CAST(HASHBYTES('SHA2_256', [id]) AS binary(32)) PERSISTED NOT NULL, [space_hash] AS CAST(HASHBYTES('SHA2_256', [space]) AS binary(32)) PERSISTED NOT NULL, [key_hash] AS CAST(HASHBYTES('SHA2_256', [key]) AS binary(32)) PERSISTED NOT NULL, PRIMARY KEY ([id_hash], [space_hash], [key_hash]));
       IF OBJECT_ID(N'${leases}', N'U') IS NULL
         CREATE TABLE ${leases} ([name] binary(16) NOT NULL PRIMARY KEY, [holder] uniqueidentifier NULL, [token] bigint NOT NULL, [renewed] datetime2 NOT NULL, [duration] int NOT NULL);
       IF OBJECT_ID(N'${tokens}', N'SO') IS NULL
         EXEC (N'CREATE SEQUENCE ${tokens} AS bigint START WITH 1');`,
    );
  });
}
