import sql from 'mssql';

import { cellNumber } from './cells.ts';
import { SqlServerUnavailableError, SqlServerVersionError } from './errors.ts';
import { query } from './sql-server-request.ts';
import { SqlServerSession } from './sql-server-session.ts';

// One database on a SQL Server, named by an ADO.NET connection string
// (Server=host,port;Database=name;User Id=...;Password=...), the form SQL
// Server's own tools print.
export class SqlServerDatabase {
  // Server and database, without credentials.
  readonly location: string;
  readonly #config: sql.config;

  constructor(connectionString: string) {
    const config = sql.ConnectionPool.parseConnectionString(connectionString);
    // Without a database the login's default one opens, which the caller
    // did not choose.
    if (!config.server || !config.database)
      throw new TypeError(
        'A SQL Server connection string must name its Server and its Database',
      );
    const instance = config.options?.instanceName;
    this.location = `${config.server}${instance ? `\\${instance}` : ''}:${config.port ?? 1433}/${config.database}`;
    // A read streams a whole table, so no time limit fits every table.
    this.#config = { ...config, requestTimeout: 0, pool: { min: 0, max: 4 } };
    Object.freeze(this);
  }

  async open(): Promise<SqlServerSession> {
    const pool = new sql.ConnectionPool(this.#config);
    try {
      await pool.connect();
    } catch (cause) {
      throw new SqlServerUnavailableError(this.location, cause);
    }
    try {
      const [[edition, major, snapshot] = []] = await query(
        pool.request(),
        `SELECT CAST(SERVERPROPERTY('EngineEdition') AS int), CAST(SERVERPROPERTY('ProductMajorVersion') AS int), CAST(snapshot_isolation_state AS int) FROM sys.databases WHERE database_id = DB_ID()`,
      );
      const version = cellNumber(major, 'ProductMajorVersion');
      // Azure SQL Database (5) and Managed Instance (8) report version 12
      // but run the current engine.
      if (edition !== 5 && edition !== 8 && version < 13)
        throw new SqlServerVersionError(this.location, version);
      return new SqlServerSession(pool, this.location, snapshot === 1);
    } catch (error) {
      await pool.close();
      throw error;
    }
  }
}
