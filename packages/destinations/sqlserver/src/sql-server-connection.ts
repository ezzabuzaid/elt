import type {
  SqlServerConnection,
  SqlServerDatabase,
} from '@eltjs/sdk-microsoft-sql-server';

import { quote } from './sql-server-identifiers.ts';

// The parts of a SQL Server login, or an ADO.NET connection string.
export type SqlServerLogin = ConstructorParameters<typeof SqlServerDatabase>[0];

// One session of the database for the destination: a statement that fails
// inside a transaction rolls the whole transaction back, so no commit keeps
// a part of its writes.
export async function connect(
  database: SqlServerDatabase,
): Promise<SqlServerConnection> {
  const connection = await database.connect();
  try {
    await connection.query('SET XACT_ABORT ON');
    return connection;
  } catch (error) {
    await connection[Symbol.asyncDispose]();
    throw error;
  }
}

// What work does becomes durable and visible together, or not at all.
// BEGIN and COMMIT are batches of their own, with no parameters, as
// sp_executesql must end with the transaction count it began with.
export async function transaction<T>(
  connection: SqlServerConnection,
  work: () => Promise<T>,
): Promise<T> {
  await connection.query('BEGIN TRANSACTION');
  try {
    const result = await work();
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await connection.query('IF @@TRANCOUNT > 0 ROLLBACK');
    } catch (rollback) {
      throw new SuppressedError(
        rollback,
        error,
        'The transaction failed, and its rollback failed too',
      );
    }
    throw error;
  }
}

// Holds the application lock elt:<name> until the transaction ends, so the
// transactions that take the lock of one name run one at a time (ADR 0009).
// The DDL that makes a schema and the objects its loads, views and
// checkpoints share takes the lock of the schema: SQL Server refuses a second
// session's CREATE SCHEMA or CREATE TABLE of the same name.
export async function takeLock(
  connection: SqlServerConnection,
  name: string,
): Promise<void> {
  await connection.query(
    `DECLARE @result int;
     EXEC @result = sp_getapplock @Resource = @resource, @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = -1;
     IF @result < 0 THROW 50000, N'The lock was not granted', 1;`,
    { resource: `elt:${name}` },
  );
}

// Makes the schema in a transaction of its own under its lock, when the
// database has none. connection is outside any transaction.
export async function makeSchema(
  connection: SqlServerConnection,
  schema: string,
): Promise<void> {
  const [made] = await connection.query(
    'SELECT CASE WHEN SCHEMA_ID(@schema) IS NULL THEN 0 ELSE 1 END AS made',
    { schema },
  );
  if (made?.made === 1) return;
  await transaction(connection, async () => {
    await takeLock(connection, schema);
    await connection.query(
      `IF SCHEMA_ID(@schema) IS NULL EXEC (N'CREATE SCHEMA ${quote(schema).replaceAll("'", "''")}')`,
      { schema },
    );
  });
}
