import type { DatabaseSync } from 'node:sqlite';

import { Declaration } from '@zukhruf/sqlite-drift';
import { transaction } from '@zukhruf/sqlite-transaction';

import type { ReaderRelation } from '@workspace/elt';

import { describe } from './sqlite-descriptions.ts';

export type SQLiteView = ReaderRelation & { readonly query: string };

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export function viewDefinition(view: SQLiteView): string {
  return `CREATE VIEW ${quote(view.name)} AS ${view.query}`;
}

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
 * dependencies before dependents. Only a named view whose stored definition
 * differs is replaced, so a publication that changes nothing leaves the schema
 * as it was.
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
  // catches the error and continues its transaction. With no transaction of
  // the caller, it begins deferred.
  transaction(
    database,
    () => {
      // A declaration refuses an element of more than one statement, so a
      // query cannot append DDL.
      new Declaration(views.map(viewDefinition), { rows: 'replace' }).apply(
        database,
      );
      for (const view of views) {
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
    },
    { mode: 'deferred' },
  );
}
