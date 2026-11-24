# The pool keeps an idle connection for five minutes

Status: accepted (2026-11-24, #5380).

`SqlServerDatabase.open()` makes one `ConnectionPool` of mssql for each `SqlServerSession`, with at most four connections. The pool closes a connection that is idle for longer than `idleTimeoutMillis`. Before it lends a connection, it runs `SELECT 1` on it (`validateConnection`, the default of mssql 12).

The watch of `@eltjs/source-microsoft-sql-server` keeps one session for all of its change checks, and it checks each 30 seconds. With the default `idleTimeoutMillis` of mssql, 30 seconds, the pool closed the connections between two checks, so each check logged in again, up to four times. On Azure SQL Database each login goes through the gateway with TLS. The change checks of datahub on Azure SQL failed in bursts with "The operation was aborted due to timeout" after their limit of 10 seconds, while the server ran no slow or blocked request in the same time.

A probe of elt #5290 on Azure SQL Database saw a session idle for 10 minutes answer, and a session idle for 20 minutes end. Microsoft documents that the gateway closes a session idle for 30 minutes.

## Decision

- The pool keeps an idle connection for 5 minutes (`idleTimeoutMillis: 300000`). This is ten times the interval of a watch check, so a session that runs a query each 30 seconds logs in only once. It is half the longest idle time that the probe saw a session live through the gateway.
- The pool keeps `SELECT 1` before it lends a connection. When the server or the network ended an idle connection, the pool closes it and logs in again.
- No host sets the value. The idle limit of the gateway is a fact of the server, and the interval of a watch check is a fact of the source.

## Considered Options

- **The default of mssql, 30 seconds.** Each watch check logs in again.
- **A pool for each watch check.** Each check logs in again, and the watch already keeps one session.
- **A minimum of connections (`min`).** The pool then keeps connections open also for a session that runs nothing, and the gateway can end them all the same.
- **An idle time near the limit of the gateway.** The pool would lend connections that the gateway ended, and each lend would then wait for a failed `SELECT 1`.
- **5 minutes.** This option was selected.

## Consequences

- A session keeps up to four logins on the server for 5 minutes after its last query, or until it is disposed.
- A query that follows an idle time longer than 5 minutes logs in again.

Sources: #5380; elt #5290; elt-sqlserver ADR 0016; `node_modules/mssql/lib/base/connection-pool.js` (the defaults of tarn); `node_modules/mssql/lib/tedious/connection-pool.js` (`_poolValidate`).
