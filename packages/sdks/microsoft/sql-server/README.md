# @eltjs/sdk-microsoft-sql-server

Reads one SQL Server database, and gives the sessions that write it. This SDK knows nothing of elt. It works with SQL Server 2016 or later, Azure SQL Database and Azure SQL Managed Instance. [@eltjs/source-microsoft-sql-server](../../../sources/microsoft/sql-server/README.md) uses it to make the streams of a pipeline.

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
- `open({ signal })` gives a `SqlServerSession`. Dispose the session to close its connections. When the signal aborts, `open` cancels its query, closes its connections and fails with the reason of the signal. The connection itself does not take the signal: the driver stops trying to connect after 15 seconds. Neither does the `SELECT 1` with which the pool checks a connection before it lends it: when the server stops sending, the pool stops waiting after 30 seconds. The session has up to four connections. The pool keeps a connection that is idle for 5 minutes, so a session that runs a query each 30 seconds, as the watch of a source does, logs in only once ([ADR 0001](docs/adr/0001-the-pool-keeps-an-idle-connection-for-five-minutes.md)).
- `connect(clock)` gives a `SqlServerConnection`: one session of the server, for work that keeps state from one statement to the next, such as a `#temp` table, the session context, a session lock or a transaction over several statements. `query(text, parameters, { signal })` runs one batch and gives the rows of each result set. Each parameter is an `nvarchar(max)` or `NULL`, which the batch casts. A batch with parameters runs through `sp_executesql`: it must end with the transaction count that it began with, and SQL Server drops each `#temp` table that it makes at its end. A batch with no parameters runs as it is, so `BEGIN TRANSACTION`, `COMMIT` and a `#temp` table that the session keeps go in such a batch. When the `signal` aborts, the connection sends SQL Server an attention (the message of the TDS protocol that cancels the batch that runs), and `query` fails with the reason of the signal after the server stops the batch. The session stays open, so the next `query` runs on it. When the signal is already aborted, `query` sends nothing and fails with its reason. The connection has no time limit for a batch, so use `AbortSignal.timeout(ms)` to stop a batch after a time. When the connection runs no statement for a minute on `clock`, it runs `SELECT 1`, so a gateway that ends idle sessions, such as that of Azure SQL, keeps the session while its owner holds it. An app gives `globalThis` as the clock. The connection never connects again: when the server or the network ends the session, it emits `end`, and each later `query` fails with `SqlServerUnavailableError`.
- `pool()` logs in once to check the login and gives a `SqlServerPool`, for statements that each stand alone, such as the renewal of a lease every few seconds. A login that the server refuses fails as it does for `open`. Dispose the pool to close its connections. `connect()` gives a `SqlServerPoolSession`. Each `query(text, parameters)` of the session runs on a connection that the pool lends for that statement alone, so the session keeps no `#temp` table, session lock or transaction from one statement to the next. Each parameter is an `nvarchar(max)`. `on('error')` gets the errors of the connections of the pool until `close()`, and a closed session runs no statement. The pool has up to four connections and keeps an idle connection for 5 minutes, as the pool of `open` does, so sessions a few seconds apart log in once. The session has the shape of the session of `SqlServerStore` of `@zukhruf/mutex/sqlserver`, which runs one statement on each session and closes it.
- `tables({ signal })` gives each user table that the login can read. A view is not in the list. Each `SqlServerTable` has its columns, its primary key and its Change Tracking state. `unreadable` names the columns that the login cannot read. Its queries read the metadata of every table, so an open `TRUNCATE` or `ALTER` of any table blocks them. When the signal aborts, the session cancels them, as `statistics` does, and `tables` fails with the reason of the signal.
- `rows`, `page`, `rowversions` and `changes` take a `SqlServerRead`: a `clock`, which an app gives as `globalThis`, and a `signal`, which stops the read also when the server sends nothing. A read that gets no row between two checks an hour apart fails with `SqlServerUnavailableError`.
- `rows`, `page` and `rowversions` read rows of a table. `changes` gives the rows that changed after a `ChangePosition`, each row once.
- `version`, `statistics`, `rowCounts` and `lastWrites` give the values that show that a table changed. `statistics`, `rowCounts` and `lastWrites` read every table of the database, so an open `TRUNCATE` or `ALTER` of any table blocks them. Each takes `{ signal }`: when the signal aborts, the session sends SQL Server an attention, as `query` of `SqlServerConnection` does, and the read fails with the reason of the signal after the server stops the query. `statistics`, `rowCounts` and `lastWrites` also take `lockTimeout`, the number of milliseconds that the query waits for a lock that another session holds. When the query waits longer, it fails with `SqlServerLockTimeoutError` (SQL Server error 1222). Without `lockTimeout`, the query waits as long as the lock is held. The lock timeout applies to that query only: the query runs through `sp_executesql`, and SQL Server restores `SET LOCK_TIMEOUT` at the end of that scope, also when the query fails or is cancelled. Thus the next statement on the pooled connection waits again as long as the lock is held.

## Errors

| Error                       | The cause                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `SqlServerUnavailableError` | The server cannot be reached.                                                                     |
| `SqlServerLoginError`       | The server refuses the login.                                                                     |
| `SqlServerPermissionError`  | The login does not have a permission. `grant` names the statement that gives the permission.      |
| `SqlServerLockTimeoutError` | A query waited longer for a lock than its `lockTimeout` allows. A later attempt can succeed.      |
| `SqlServerVersionError`     | The server is older than SQL Server 2016.                                                         |
| `ChangeHistoryExpiredError` | The Change Tracking history no longer includes the position. Read the table again from the start. |
