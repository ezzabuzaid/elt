import type { DatabaseSync } from 'node:sqlite';
import type { ReaderRelation } from 'elt';
import { describe } from './sqlite-descriptions.ts';

export type SQLiteView = ReaderRelation & { readonly query: string };

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

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
 * Publish ordinary views and their descriptions on a caller-owned connection,
 * inside its transaction when one is open. Supply trusted SQL and list
 * dependencies before dependents. Only the named views are replaced.
 */
export function publishSQLiteViews(
  database: DatabaseSync,
  { views }: { views: readonly SQLiteView[] },
): void {
  const names = new Set<string>();
  for (const view of views) {
    text(view.name, 'view name');
    if (/^_elt_/i.test(view.name))
      throw new TypeError('View names starting with _elt_ are reserved');
    if (names.has(view.name.toLowerCase()))
      throw new TypeError('Duplicate view names');
    names.add(view.name.toLowerCase());
    text(view.query, 'view query');
    text(view.description, 'view description');
    for (const [column, description] of Object.entries(view.columns)) {
      text(column, 'column name');
      text(description, 'column description');
    }
  }
  if (views.length === 0) return;

  // A failed definition restores every replaced view, even if the caller
  // catches the error and continues its transaction.
  database.exec('SAVEPOINT publish');
  try {
    for (const view of views.toReversed())
      database.exec(`DROP VIEW IF EXISTS ${quote(view.name)}`);
    for (const view of views) {
      // A prepared statement runs one statement, so a query cannot append DDL.
      database
        .prepare(`CREATE VIEW ${quote(view.name)} AS ${view.query}`)
        .run();
      const columns = database
        .prepare('SELECT "name" FROM pragma_table_info(?)')
        .all(view.name)
        .map(({ name }) => String(name));
      if (
        columns.length !== Object.keys(view.columns).length ||
        columns.some((name) => !Object.hasOwn(view.columns, name))
      )
        throw new TypeError(
          `View ${quote(view.name)} must describe exactly its output columns: ${columns.join(', ')}`,
        );
      describe(
        database,
        view.name,
        view.description,
        Object.fromEntries(
          Object.entries(view.columns).map(([column, description]) => [
            column,
            { description },
          ]),
        ),
      );
    }
    database.exec('RELEASE publish');
  } catch (error) {
    if (database.isTransaction) {
      database.exec('ROLLBACK TO publish');
      database.exec('RELEASE publish');
    }
    throw error;
  }
}
