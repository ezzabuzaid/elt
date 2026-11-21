import type { ReaderRelation } from '@eltjs/elt';
import type { SqlServerConnection } from '@eltjs/sdk-microsoft-sql-server';

import { takeLock } from './sql-server-connection.ts';
import { refreshDependents } from './sql-server-dependents.ts';
import { TargetDescriptions } from './sql-server-descriptions.ts';
import { quote } from './sql-server-identifiers.ts';
import { inMarts, marts } from './sql-server-schemas.ts';

export type SqlServerView = ReaderRelation & { readonly query: string };

// Publishes views and their descriptions in marts, inside the caller's
// transaction, under the lock of marts, which it makes when the database has
// none. A view whose stored definition is the text its query makes stays as
// it is; the others are made again in place, so each keeps its object and
// its grants, and the views over each one that are not in views read its
// new columns (ADR 0006). A view made again must have exactly the columns
// that it describes; the descriptions of the columns a view does not have
// yet, such as a view over * before its table takes a new column, wait for
// a later publication. Supply trusted SQL, and list dependencies before
// dependents.
export async function publishViews(
  connection: SqlServerConnection,
  views: readonly SqlServerView[],
): Promise<void> {
  await takeLock(connection, marts);
  await connection.query(
    `IF SCHEMA_ID(N'${marts}') IS NULL EXEC (N'CREATE SCHEMA ${quote(marts)}')`,
  );
  for (const view of views) {
    const relation = inMarts(view.name);
    const changed = !(await stored(connection, relation, view.query));
    // CREATE VIEW must be the only statement of its batch.
    if (changed)
      await refreshDependents(
        connection,
        {
          roots: [relation],
          views: views.map(({ name }) => inMarts(name)),
          changed: relation,
        },
        async () => {
          await connection.query(
            `CREATE OR ALTER VIEW ${relation} AS ${view.query}`,
          );
        },
      );
    const columns = (
      await connection.query(
        'SELECT [name] FROM sys.columns WHERE [object_id] = OBJECT_ID(@view) ORDER BY [column_id]',
        { view: relation },
      )
    ).map(({ name }) => String(name));
    if (
      changed &&
      (columns.length !== Object.keys(view.columns).length ||
        columns.some((name) => !Object.hasOwn(view.columns, name)))
    )
      throw new TypeError(
        `View ${relation} must describe exactly its output columns: ${columns.join(', ')}`,
      );
    await new TargetDescriptions(
      view.description,
      Object.fromEntries(
        Object.entries(view.columns).filter(([name]) => columns.includes(name)),
      ),
    ).write(connection, 'VIEW', marts, view.name);
  }
}

// Whether the view in marts has the definition that query makes. SQL Server
// keeps the text of the statement that made the view, with CREATE OR ALTER
// VIEW kept as CREATE   VIEW (probe of 2026-11-20), so the comparison skips
// the words before the name.
async function stored(
  connection: SqlServerConnection,
  relation: string,
  query: string,
): Promise<boolean> {
  const [view] = await connection.query(
    "SELECT OBJECT_DEFINITION(OBJECT_ID(@view, N'V')) AS [definition]",
    { view: relation },
  );
  return (
    typeof view?.definition === 'string' &&
    view.definition.replace(/^CREATE\s+(?:OR\s+ALTER\s+)?VIEW\s+/i, '') ===
      `${relation} AS ${query}`
  );
}

// Removes a view and each view over it, deepest first, inside the caller's
// transaction under the lock of marts, as elt-postgresql drops a view with
// CASCADE and dbt drops a model's relation: a view of the pipeline over it
// waits or is made again by its own refresh, and a view that someone made
// over it is gone. SQL Server keeps the dependency of a view by name, so a
// view over a dropped view would stay, and fail each read with error 4413.
export async function withdrawView(
  connection: SqlServerConnection,
  name: string,
): Promise<void> {
  await takeLock(connection, marts);
  const readers = await connection.query(
    `WITH [readers] AS (
       SELECT d.[referencing_id] AS [id], 1 AS [depth] FROM sys.sql_expression_dependencies AS d
       WHERE d.[referenced_id] = OBJECT_ID(@view, N'V')
       UNION ALL
       SELECT d.[referencing_id], r.[depth] + 1 FROM [readers] AS r
       JOIN sys.sql_expression_dependencies AS d ON d.[referenced_id] = r.[id]
     )
     SELECT QUOTENAME(OBJECT_SCHEMA_NAME([id])) + N'.' + QUOTENAME(OBJECT_NAME([id])) AS [view]
     FROM [readers] WHERE OBJECTPROPERTY([id], 'IsView') = 1
     GROUP BY [id] ORDER BY MAX([depth]) DESC`,
    { view: inMarts(name) },
  );
  for (const { view } of readers)
    await connection.query(`DROP VIEW ${String(view)}`);
  await connection.query(`DROP VIEW IF EXISTS ${inMarts(name)}`);
}
