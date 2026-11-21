import { DatabaseFiles, type FailureType } from '@eltjs/elt';
import type {
  SqlServerConnection,
  SqlServerDatabase,
} from '@eltjs/sdk-microsoft-sql-server';

import {
  connect,
  makeSchema,
  takeLock,
  transaction,
} from './sql-server-connection.ts';
import { failureType } from './sql-server-failure-type.ts';
import { inWarehouse, warehouse } from './sql-server-schemas.ts';

const table = inWarehouse('_elt_files');

// Each parameter is an nvarchar, so each is cast to the type of its column,
// which the key can seek (ADR 0015).
const scope = 'CAST(@scope AS char(64))';
const name = (parameter: string) => `CAST(@${parameter} AS varchar(128))`;

// The files of a copy in the database of its destination, in
// _warehouse._elt_files, which readers of marts do not see.
export class SqlServerFiles extends DatabaseFiles<SqlServerConnection> {
  override readonly identity = JSON.stringify({ type: 'sql-server-files' });
  readonly #database: SqlServerDatabase;

  constructor(database: SqlServerDatabase) {
    super('_warehouse._elt_files');
    this.#database = database;
    Object.freeze(this);
  }

  // Two sessions make the table at once, and SQL Server refuses the second
  // CREATE; the lock of _warehouse makes them take turns. A scope and a name
  // compare by their bytes, as in SQLite and Postgres: the collation of a
  // database can ignore case, and then a.PDF and a.pdf, the same bytes with
  // two extensions, would be one file (ADR 0015).
  protected override async connect(): Promise<SqlServerConnection> {
    const connection = await connect(this.#database);
    try {
      const [found] = await connection.query(
        `SELECT IIF(OBJECT_ID(N'${table}', N'U') IS NULL, 0, 1) AS [made]`,
      );
      if (found?.made !== 1) {
        await makeSchema(connection, warehouse);
        await transaction(connection, async () => {
          await takeLock(connection, warehouse);
          await connection.query(
            `IF OBJECT_ID(N'${table}', N'U') IS NULL
               CREATE TABLE ${table} ([scope] char(64) COLLATE Latin1_General_BIN2 NOT NULL, [name] varchar(128) COLLATE Latin1_General_BIN2 NOT NULL, [n] bigint NOT NULL, [bytes] varbinary(max) NOT NULL, PRIMARY KEY ([scope], [name], [n]))`,
          );
        });
      }
      return connection;
    } catch (error) {
      await connection[Symbol.asyncDispose]();
      throw error;
    }
  }

  // The chunk travels as base64 in one JSON parameter, which OPENJSON reads
  // as varchar: BASE64_DECODE takes no nvarchar (ADR 0011).
  protected override async write(
    connection: SqlServerConnection,
    key: string,
    file: string,
    n: number,
    bytes: Uint8Array,
  ): Promise<void> {
    await connection.query(
      `INSERT INTO ${table} ([scope], [name], [n], [bytes]) SELECT ${scope}, ${name('name')}, j.[n], BASE64_DECODE(j.[b]) FROM OPENJSON(@chunk) WITH ([n] bigint '$.n', [b] varchar(max) '$.b') AS j`,
      {
        scope: key,
        name: file,
        chunk: JSON.stringify({ n, b: bytes.toBase64() }),
      },
    );
  }

  protected override async rename(
    connection: SqlServerConnection,
    key: string,
    from: string,
    to: string,
  ): Promise<void> {
    await connection.query(
      `UPDATE ${table} SET [name] = ${name('to')} WHERE [scope] = ${scope} AND [name] = ${name('from')} AND NOT EXISTS (SELECT 1 FROM ${table} WHERE [scope] = ${scope} AND [name] = ${name('to')})`,
      { scope: key, from, to },
    );
  }

  protected override async remove(
    connection: SqlServerConnection,
    key: string,
    names: readonly string[],
  ): Promise<void> {
    await connection.query(
      `DELETE FROM ${table} WHERE [scope] = ${scope} AND [name] IN (SELECT CAST([value] AS varchar(128)) FROM OPENJSON(@names))`,
      { scope: key, names: JSON.stringify(names) },
    );
  }

  protected override async names(
    connection: SqlServerConnection,
    key: string,
  ): Promise<readonly string[]> {
    return (
      await connection.query(
        `SELECT [name] FROM ${table} WHERE [scope] = ${scope} AND [n] = 0`,
        { scope: key },
      )
    ).map((row) => String(row.name));
  }

  protected override async read(
    connection: SqlServerConnection,
    key: string,
    file: string,
    n: number,
    length: number,
  ): Promise<Uint8Array | undefined> {
    const [row] = await connection.query(
      `SELECT SUBSTRING([bytes], 1, CAST(@length AS int)) AS [bytes] FROM ${table} WHERE [scope] = ${scope} AND [name] = ${name('name')} AND [n] = CAST(@n AS bigint)`,
      { scope: key, name: file, n: String(n), length: String(length) },
    );
    if (row === undefined) return undefined;
    if (!(row.bytes instanceof Uint8Array))
      throw new TypeError(`Chunk ${n} of stored file ${file} is not VARBINARY`);
    return row.bytes;
  }

  override failureType(error: unknown): FailureType {
    return failureType(error);
  }
}
