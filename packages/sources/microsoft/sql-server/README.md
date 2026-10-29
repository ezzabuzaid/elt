# @workspace/source-microsoft-sql-server

An ELT source for one SQL Server database. Each user table that the login can read becomes a stream named `<schema>.<table>`. The source needs SQL Server 2016 or later, Azure SQL Database or Azure SQL Managed Instance.

```ts
import { Connection, Pipeline } from '@workspace/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@workspace/elt-postgresql';
import { SqlServerDatabase } from '@workspace/sdk-microsoft-sql-server';
import { sqlServerCopies } from '@workspace/source-microsoft-sql-server/sql-server-copies';
import { SqlServerSource } from '@workspace/source-microsoft-sql-server/sql-server-source';

const url = 'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';
const schema = 'shop';

const database = new SqlServerDatabase(
  'Server=sql.example.com,1433;Database=shop;User Id=reader;Password=...;Encrypt=true',
);
const source = await SqlServerSource.discover(database, { schemas: ['dbo'] });
const destination = new PostgresDestination({ url, schema });

await new Pipeline({
  history: new PostgresSyncHistory({ url }),
  connections: [
    new Connection({
      name: 'sql-server',
      source,
      destination,
      checkpoints: new PostgresCheckpointStore({ url, schema }),
      steps: sqlServerCopies(source, (stream) => destination.table(stream)),
    }),
  ],
}).run();
```

The connection string is an ADO.NET connection string. It must name a `Database`. `SqlServerSource.discover` reads the tables one time, so discover again on each run. `sqlServerCopies` makes one copy for each table, with the ID `<source identity>/<schema>.<table>` (`sql-server:shop/dbo.orders`), so two databases that have a table with the same name can be in one pipeline. Each table reads with the first strategy that it can use:

| Strategy        | When                                                                   | Copy                          |
| --------------- | ---------------------------------------------------------------------- | ----------------------------- |
| Change Tracking | the table has a key, tracks changes, and the login can see its changes | `incremental`, `append_dedup` |
| Rowversion      | the table has a key and a `rowversion` column                          | `incremental`, `append_dedup` |
| Full refresh    | all other tables                                                       | `full_refresh`, `overwrite`   |

## Access

A read-only login is sufficient: `db_datareader`, and `VIEW CHANGE TRACKING` on each tracked table. You do not have to enable a feature on the server.

- A server that does not open fails with `SqlServerUnavailableError`. It names the server and the database, but not the credentials.
- When a grant is revoked after discovery, only that table's stream fails, with `SqlServerPermissionError`, which names the grant.
- A schema in `schemas` that holds no table that the login can read fails the discovery.

## Limitations

- Rowversion tables do not see deletions. A deleted row stays.
- The source does not read CDC.
- In one case, the source does not see a truncate, or tracking that was turned off and on: when the table's tracking began at the version that the last sync read, and nothing that is tracked changed in the database since.
- A value longer than the longest JavaScript string (about 512 million characters) fails its stream.
- The source discovers tables only, not views.

See [docs/reference.md](../../../../docs/reference.md#sql-server).
