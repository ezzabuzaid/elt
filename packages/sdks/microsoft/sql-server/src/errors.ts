// The server, or the database the connection string names, refused the
// connection: it is down, the address or credentials are wrong, or the login
// cannot open that database.
export class SqlServerUnavailableError extends Error {
  override name = 'SqlServerUnavailableError';

  constructor(location: string, cause: unknown) {
    super(`SQL Server ${location} cannot be opened.`, { cause });
  }
}

// The login lacks a permission a read needs. grant names what to give it.
export class SqlServerPermissionError extends Error {
  override name = 'SqlServerPermissionError';
  readonly grant: string;

  constructor(grant: string, cause?: unknown) {
    super(`SQL Server refused the read; grant the login ${grant}.`, { cause });
    this.grant = grant;
  }
}

// Reading needs SQL Server 2016 or later (or Azure SQL): the masking and
// external-table metadata and the text styles the reads rely on start there.
export class SqlServerVersionError extends Error {
  override name = 'SqlServerVersionError';

  constructor(location: string, version: number) {
    super(
      `SQL Server ${location} is version ${version}; reading it needs SQL Server 2016 (13) or later.`,
    );
  }
}

// The saved Change Tracking version is no longer one the table's change
// history covers: cleanup removed what followed it, the table was truncated,
// or the database was restored. The table has to be read in full again.
export class ChangeHistoryExpiredError extends Error {
  override name = 'ChangeHistoryExpiredError';

  constructor(table: string, since: string) {
    super(
      `The change history of ${table} no longer covers version ${since}; read the table in full again.`,
    );
  }
}
