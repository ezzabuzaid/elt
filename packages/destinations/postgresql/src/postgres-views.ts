import type postgres from 'postgres';

import type { ReaderRelation } from '@workspace/elt';

import { identifier, quote } from './identifier.ts';
import { schemaLock, schemaName } from './postgres-session.ts';

export type PostgresView = ReaderRelation & { readonly query: string };

function text(value: string, what: string): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    !value.isWellFormed()
  )
    throw new TypeError(`Invalid ${what}`);
}

/**
 * Publish ordinary views and their descriptions in a caller-owned transaction.
 * Supply trusted SQL and list dependencies before dependents. Only the named
 * views are replaced; outside dependents prevent replacement (no CASCADE).
 * Reapply any explicit grants in the same transaction after publishing.
 */
export async function publishPostgresViews(
  sql: postgres.TransactionSql,
  { schema, views }: { schema: string; views: readonly PostgresView[] },
): Promise<void> {
  schemaName(schema);
  const names = new Set<string>();
  for (const view of views) {
    identifier(view.name, 'view name');
    if (names.has(view.name)) throw new TypeError('Duplicate view names');
    names.add(view.name);
    text(view.query, 'view query');
    text(view.description, 'view description');
    for (const [column, description] of Object.entries(view.columns)) {
      identifier(column, 'column name');
      text(description, 'column description');
    }
  }
  if (views.length === 0) return;

  // A failed definition restores every replaced view, even if the caller
  // catches the error and continues its transaction.
  await sql.savepoint(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${schemaLock(schema)}, 0))`;
    await transaction.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quote(schema)}`);
    for (const view of views.toReversed())
      await transaction.unsafe(
        `DROP VIEW IF EXISTS ${quote(schema)}.${quote(view.name)}`,
      );
    for (const view of views) {
      const relation = `${quote(schema)}.${quote(view.name)}`;
      // Extended protocol accepts one statement, so a query cannot append DDL.
      await transaction`CREATE VIEW ${transaction.unsafe(relation)} AS ${transaction.unsafe(view.query)}`;
      const columns = await transaction<{ name: string }[]>`
        SELECT attname AS name FROM pg_attribute
        WHERE attrelid = to_regclass(${relation})
          AND attnum > 0 AND NOT attisdropped ORDER BY attnum`;
      if (
        columns.length !== Object.keys(view.columns).length ||
        columns.some(({ name }) => !Object.hasOwn(view.columns, name))
      )
        throw new TypeError(
          `View ${relation} must describe exactly its output columns: ${columns.map(({ name }) => name).join(', ')}`,
        );

      // COMMENT cannot bind values; Postgres quotes names and text itself.
      const comments = await transaction<{ statement: string }[]>`
        SELECT format('COMMENT ON VIEW %I.%I IS %L', ${schema}::text,
          ${view.name}::text, ${view.description}::text) AS statement
        UNION ALL
        SELECT format('COMMENT ON COLUMN %I.%I.%I IS %L', ${schema}::text,
          ${view.name}::text, key, value)
        FROM jsonb_each_text(${transaction.json(view.columns)}::jsonb)`;
      for (const { statement } of comments) await transaction.unsafe(statement);
    }
  });
}
