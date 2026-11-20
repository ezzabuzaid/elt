import type { ReaderRelation } from '@eltjs/elt';
import type { SqlServerConnection } from '@eltjs/sdk-microsoft-sql-server';

import { lockSchema } from './sql-server-connection.ts';
import { TargetDescriptions } from './sql-server-descriptions.ts';
import { quote } from './sql-server-identifiers.ts';
import { inMarts, marts } from './sql-server-schemas.ts';

export type SqlServerView = ReaderRelation & { readonly query: string };

// Publishes views and their descriptions in marts, inside the caller's
// transaction, under the lock of marts, which it makes when the database has
// none. A view whose stored definition is
// the one its query makes stays as it is; the others are made again in
// place, so each keeps its object and its grants. Supply trusted SQL, and
// list dependencies before dependents.
export async function publishViews(
  connection: SqlServerConnection,
  views: readonly SqlServerView[],
): Promise<void> {
  await lockSchema(connection, marts);
  await connection.query(
    `IF SCHEMA_ID(N'${marts}') IS NULL EXEC (N'CREATE SCHEMA ${quote(marts)}')`,
  );
  for (const view of views) {
    const relation = inMarts(view.name);
    const definition = `CREATE OR ALTER VIEW ${relation} AS ${view.query}`;
    const [stored] = await connection.query(
      "SELECT OBJECT_DEFINITION(OBJECT_ID(@view, N'V')) AS [definition]",
      { view: relation },
    );
    // CREATE VIEW must be the only statement of its batch.
    if (stored?.definition !== definition) await connection.query(definition);
    const columns = await connection.query(
      'SELECT [name] FROM sys.columns WHERE [object_id] = OBJECT_ID(@view) ORDER BY [column_id]',
      { view: relation },
    );
    if (
      columns.length !== Object.keys(view.columns).length ||
      columns.some(({ name }) => !Object.hasOwn(view.columns, String(name)))
    )
      throw new TypeError(
        `View ${relation} must describe exactly its output columns: ${columns.map(({ name }) => String(name)).join(', ')}`,
      );
    await new TargetDescriptions(view.description, view.columns).write(
      connection,
      'VIEW',
      marts,
      view.name,
    );
  }
}
