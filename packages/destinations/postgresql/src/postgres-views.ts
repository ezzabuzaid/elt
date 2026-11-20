import postgres from 'postgres';

import type { ReaderRelation } from '@eltjs/elt';

import { identifier, quote } from './identifier.ts';
import { rebindDependents } from './postgres-dependents.ts';
import { inMarts, marts } from './postgres-schemas.ts';
import { lockSchema } from './postgres-session.ts';

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

// Refuses, with no I/O, a view that Postgres cannot hold as it is declared.
export function checkView(view: PostgresView): void {
  identifier(view.name, 'view name');
  text(view.query, 'view query');
  text(view.description, 'view description');
  for (const [column, description] of Object.entries(view.columns)) {
    identifier(column, 'column name');
    text(description, 'column description');
  }
}

// Publishes ordinary views and their descriptions in a caller-owned
// transaction, in marts, where the bare names of their queries are found
// too. Supply trusted SQL, and list dependencies before dependents. A view
// whose stored definition is the one its query makes stays as it is, with
// its OID, so a publication that changes nothing changes no view; the others
// are made again, and the views that read them read the new ones (ADR 0006).
export async function publishPostgresViews(
  sql: postgres.TransactionSql,
  views: readonly PostgresView[],
): Promise<void> {
  const names = new Set<string>();
  for (const view of views) {
    checkView(view);
    if (names.has(view.name)) throw new TypeError('Duplicate view names');
    names.add(view.name);
  }
  if (views.length === 0) return;

  // A failed definition restores every replaced view, even if the caller
  // catches the error and continues its transaction.
  await sql.savepoint(async (transaction) => {
    await lockSchema(transaction, marts);
    await transaction.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quote(marts)}`);
    const [{ path } = { path: '' }] = await transaction<{ path: string }[]>`
      SELECT current_setting('search_path') AS path`;
    await transaction`SELECT set_config('search_path', ${quote(marts)}, true)`;
    const changed: PostgresView[] = [];
    for (const view of views)
      if (!(await stored(transaction, view))) changed.push(view);
    if (changed.length > 0)
      await rebindDependents(
        transaction,
        changed.map(({ name }) => inMarts(name)),
        async () => {
          for (const view of changed.toReversed())
            await transaction.unsafe(
              `DROP VIEW IF EXISTS ${inMarts(view.name)}`,
            );
          for (const view of changed) {
            const relation = inMarts(view.name);
            // Extended protocol accepts one statement, so a query cannot
            // append DDL.
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
          }
        },
      );
    for (const view of views) await describe(transaction, view);
    await transaction`SELECT set_config('search_path', ${path}, true)`;
  });
}

// Whether the view in marts has the definition that its query makes now. The
// query is made as a TEMP view, which the savepoint takes back, because
// Postgres keeps a view's definition as it normalizes it, not as its text. A
// query that Postgres refuses counts as changed, so the publication fails with
// its error.
async function stored(
  sql: postgres.TransactionSql,
  view: PostgresView,
): Promise<boolean> {
  const relation = inMarts(view.name);
  const [existing] = await sql<{ definition: string | null }[]>`
    SELECT CASE WHEN c.relkind = 'v' THEN pg_get_viewdef(c.oid) END AS definition
    FROM pg_class c WHERE c.oid = to_regclass(${relation})`;
  if (existing?.definition == null) return false;
  await sql.unsafe('SAVEPOINT "_elt_candidate"');
  try {
    await sql`CREATE TEMP VIEW "_elt_candidate" AS ${sql.unsafe(view.query)}`;
    const [made] = await sql<{ definition: string }[]>`
      SELECT pg_get_viewdef('pg_temp."_elt_candidate"'::regclass) AS definition`;
    return made?.definition === existing.definition;
  } catch (error) {
    if (error instanceof postgres.PostgresError) return false;
    throw error;
  } finally {
    await sql.unsafe('ROLLBACK TO SAVEPOINT "_elt_candidate"');
    await sql.unsafe('RELEASE SAVEPOINT "_elt_candidate"');
  }
}

// COMMENT cannot bind values; Postgres quotes names and text itself.
async function describe(
  sql: postgres.TransactionSql,
  view: PostgresView,
): Promise<void> {
  const comments = await sql<{ statement: string }[]>`
    SELECT format('COMMENT ON VIEW %I.%I IS %L', ${marts}::text,
      ${view.name}::text, ${view.description}::text) AS statement
    WHERE obj_description(to_regclass(format('%I.%I', ${marts}::text, ${view.name}::text)), 'pg_class')
      IS DISTINCT FROM ${view.description}::text
    UNION ALL
    SELECT format('COMMENT ON COLUMN %I.%I.%I IS %L', ${marts}::text,
      ${view.name}::text, c.key, c.value)
    FROM jsonb_each_text(${sql.json(view.columns)}::jsonb) AS c
    JOIN pg_attribute a ON a.attrelid = to_regclass(format('%I.%I', ${marts}::text, ${view.name}::text))
      AND a.attname = c.key
    WHERE col_description(a.attrelid, a.attnum) IS DISTINCT FROM c.value`;
  for (const { statement } of comments) await sql.unsafe(statement);
}

// Removes a view, its comments and each view over it, in the lock of marts,
// as dbt drops a model's relation (`drop view if exists ... cascade`): a view
// of the pipeline over it waits or is made again by its own refresh, and a
// view that someone made over it is gone.
export async function withdrawPostgresView(
  sql: postgres.TransactionSql,
  name: string,
): Promise<void> {
  await lockSchema(sql, marts);
  await sql.unsafe(`DROP VIEW IF EXISTS ${inMarts(name)} CASCADE`);
}
