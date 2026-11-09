# @eltjs/sdk-microsoft-sql-server

Reads one SQL Server database. This SDK knows nothing of elt. It works with SQL Server 2016 or later, Azure SQL Database and Azure SQL Managed Instance. [@eltjs/source-microsoft-sql-server](../../../sources/microsoft/sql-server/README.md) uses it to make the streams of a pipeline.

```ts
import { SqlServerDatabase } from '@eltjs/sdk-microsoft-sql-server';

const database = new SqlServerDatabase(
  'Server=localhost,1433;Database=sales;User Id=reader;Password=secret;Encrypt=true',
);

await using session = await database.open();
for (const table of await session.tables()) {
  console.log(table.quoted, table.changeTracking);
}
```

- `SqlServerDatabase` takes an ADO.NET connection string. The string must name its server and its database. An `mssql://` URL does not work.
- `open` gives a `SqlServerSession`. Dispose the session to close its connections.
- `tables` gives each user table that the login can read. A view is not in the list. Each `SqlServerTable` has its columns, its primary key and its Change Tracking state. `unreadable` names the columns that the login cannot read.
- `rows`, `page` and `rowversions` read rows of a table. `changes` gives the rows that changed after a `ChangePosition`, each row once.
- `version`, `statistics`, `rowCounts` and `lastWrites` give the values that show that a table changed.

## Errors

| Error                       | The cause                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `SqlServerUnavailableError` | The server cannot be reached.                                                                     |
| `SqlServerLoginError`       | The server refuses the login.                                                                     |
| `SqlServerPermissionError`  | The login does not have a permission. `grant` names the statement that gives the permission.      |
| `SqlServerVersionError`     | The server is older than SQL Server 2016.                                                         |
| `ChangeHistoryExpiredError` | The Change Tracking history no longer includes the position. Read the table again from the start. |
