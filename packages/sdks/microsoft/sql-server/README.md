# @eltjs/sdk-microsoft-sql-server

Reads one SQL Server database. This SDK knows nothing of elt. It works with SQL Server 2016 or later, Azure SQL Database and Azure SQL Managed Instance. [@eltjs/source-microsoft-sql-server](../../../sources/microsoft/sql-server/README.md) uses it to make the streams of a pipeline.

```ts
import { SqlServerDatabase } from '@eltjs/sdk-microsoft-sql-server';

const database = new SqlServerDatabase({
  server: 'localhost',
  port: 1433,
  database: 'sales',
  user: 'reader',
  password: 'secret',
});

await using session = await database.open();
for (const table of await session.tables()) {
  console.log(table.quoted, table.changeTracking);
}
```

- `SqlServerDatabase` takes the parts of a login (`server`, `port`, `database`, `user`, `password` and `trustServerCertificate`), or an ADO.NET connection string, the form that the tools of SQL Server print. Both must name the server and the database. An `mssql://` URL does not work. Use the parts when you have them: a connection string cuts a value at its first `;` and removes its braces, so a password that holds them gets to the server only through the parts. The connection is encrypted. Set `trustServerCertificate` for a server whose certificate no authority signed, such as SQL Server in Docker.
- `open` gives a `SqlServerSession`. Dispose the session to close its connections.
- `tables` gives each user table that the login can read. A view is not in the list. Each `SqlServerTable` has its columns, its primary key and its Change Tracking state. `unreadable` names the columns that the login cannot read.
- `rows`, `page`, `rowversions` and `changes` take a `SqlServerRead`: a `clock`, which an app gives as `globalThis`, and a `signal`, which stops the read also when the server sends nothing. A read that gets no row between two checks an hour apart fails with `SqlServerUnavailableError`.
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
