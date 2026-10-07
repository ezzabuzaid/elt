import { createHash } from 'node:crypto';

import { Connection, Pipeline } from '@workspace/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
  installPostgresCatalog,
} from '@workspace/elt-postgresql';
import { SqlServerDatabase } from '@workspace/sdk-microsoft-sql-server';
import { sqlServerCopies } from '@workspace/source-microsoft-sql-server/sql-server-copies';
import { SqlServerSource } from '@workspace/source-microsoft-sql-server/sql-server-source';

const warehouseUrl = 'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';

// The SQL Server databases to load, each read through the connection string
// in SQLSERVER_<NAME>_CONNECTION_STRING, and the schemas to keep (every
// schema when absent).
const databases: readonly {
  readonly name: string;
  readonly schemas?: readonly string[];
}[] = [{ name: 'local' }];

// A name in the snake case marts use. A name the snake case changes keeps a
// hash of the original. Two tables that still land on one name, such as
// dbo_order.items and dbo.order_items, do not merge: the load of the second
// refuses the view the first made. The destination fits a long one.
function readerName(parts: readonly string[]): string {
  const original = parts.join('_');
  const snake = original.toLowerCase().replaceAll(/[^a-z0-9_]+/g, '_');
  if (snake === original) return snake;
  const hash = createHash('sha256')
    .update(parts.join('\0'))
    .digest('hex')
    .slice(0, 8);
  return `${snake}_${hash}`;
}

export default databases.map(({ name, schemas }) => ({
  name: `sql-server-${name}`,
  async run() {
    const variable = `SQLSERVER_${name.toUpperCase()}_CONNECTION_STRING`;
    const connectionString = process.env[variable];
    if (!connectionString)
      throw new Error(
        `Set ${variable} to the SQL Server connection string of ${name} (Server=host,port;Database=name;User Id=...;Password=...).`,
      );
    // Discovered again on every run, so a table whose columns changed
    // starts its copy over.
    const source = await SqlServerSource.discover(
      new SqlServerDatabase(connectionString),
      { schemas },
    );
    const raw = readerName(['sql_server', name]);
    const destination = new PostgresDestination({
      url: warehouseUrl,
      schema: raw,
    });
    const history = new PostgresSyncHistory({ url: warehouseUrl });
    await history.install();
    await installPostgresCatalog({ url: warehouseUrl, schema: 'marts' });
    await new Pipeline({
      history,
      connections: [
        new Connection({
          name: `sql-server-${name}`,
          source,
          destination,
          checkpoints: new PostgresCheckpointStore({
            url: warehouseUrl,
            schema: raw,
          }),
          // Raw tables are named after <schema>.<table> by the
          // destination's rule; readers see marts.<name>_<schema>_<table>.
          steps: sqlServerCopies(source, (stream) => {
            const [schema = '', table = ''] = stream.split(/\.(.*)/s);
            return destination
              .table(stream)
              .withReaderView('marts', readerName([name, schema, table]));
          }),
        }),
      ],
    }).run();
  },
}));
