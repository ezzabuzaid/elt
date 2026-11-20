// The database is not set up as the destination needs it: an engine older
// than SQL Server 2025, or no row versions for readers. The message gives
// what to change, such as the ALTER DATABASE statement to run.
export class SqlServerSetupError extends Error {
  override name = 'SqlServerSetupError';
}
