import type { DatabaseSync } from 'node:sqlite';

import { open } from '@zukhruf/sqlite-open';

import {
  columnsOf,
  literal,
  quote,
  readable,
  selectAsOf,
  storedViews,
  syncHistoryTables,
  syncHistoryViews,
  versioned,
} from './sqlite-as-of.ts';

/**
 * The `CREATE TEMP VIEW` statements that show the file attached as `schema`
 * as of a position, each relation as `${prefix}_${name}`, for a host that
 * reads several files in one connection: each target, each stored view with
 * its names mapped to these views, and the sync history and each view that
 * reads what keeps no row versions, which fail. Each view reads the file
 * when it is read, so it stays the same across later commits, and fails
 * through `asOfFunctions` once the file no longer reads the position exactly:
 * the retention deleted its history, or the file was made again. A position
 * the file cannot read now is expired.
 */
export function asOfDefinitions(
  database: DatabaseSync,
  {
    schema,
    position,
    prefix,
  }: {
    readonly schema: string;
    readonly position: string;
    readonly prefix: string;
  },
): readonly string[] | { readonly expired: string } {
  const asked = readable(database, position, schema);
  if ('expired' in asked) return asked;
  const named = (name: string) => `${prefix}_${name}`;
  const targets = versioned(database, schema);
  const views = storedViews(database, schema);
  const columns = new Map(
    [
      ...targets.map(({ target }) => target),
      ...views.map(({ name }) => name),
      ...syncHistoryTables,
    ]
      .map((name): [string, string[]] => [
        name,
        columnsOf(database, quote(name), schema),
      ])
      .filter(([, names]) => names.length > 0),
  );
  return [
    ...targets.map(
      (version) =>
        `CREATE TEMP VIEW ${quote(named(version.target))} AS ${selectAsOf(database, version, asked.number, schema, asked)}`,
    ),
    ...syncHistoryViews(database, schema, named),
    ...views.map(
      (view) =>
        `CREATE TEMP VIEW ${quote(named(view.name))} AS ${mapped(view, columns, named)}`,
    ),
  ];
}

// The query of a stored view with each relation it names renamed, as
// SQLite's own ALTER TABLE ... RENAME rewrites the views that name a table:
// the view is made in a database of its own beside a table of the columns of
// each other relation, and each table is renamed. A view that reads a table
// with no view of the position reads as a view that fails.
function mapped(
  { name, sql }: { readonly name: string; readonly sql: string },
  columns: ReadonlyMap<string, readonly string[]>,
  named: (name: string) => string,
): string {
  using scratch = open(':memory:');
  scratch.exec('PRAGMA legacy_alter_table = OFF');
  const others = [...columns].filter(([relation]) => relation !== name);
  for (const [relation, names] of others)
    scratch.exec(
      `CREATE TABLE ${quote(relation)} (${names.map(quote).join(', ')})`,
    );
  scratch.exec(sql);
  try {
    scratch.prepare(`SELECT * FROM ${quote(name)}`);
  } catch (error) {
    if (Error.isError(error) && /no such table: /.test(error.message))
      return `SELECT NULL WHERE "_elt_unversioned"(${literal(`View ${quote(name)} cannot be read as of a position: it reads a table that keeps no row versions (${error.message})`)})`;
    throw error;
  }
  for (const [relation] of others)
    scratch.exec(
      `ALTER TABLE ${quote(relation)} RENAME TO ${quote(named(relation))}`,
    );
  const renamed = String(
    scratch
      .prepare(`SELECT "sql" FROM sqlite_schema WHERE "name" = ?`)
      .get(name)?.sql,
  );
  const head = `CREATE VIEW ${quote(name)} AS `;
  if (!renamed.startsWith(head))
    throw new TypeError(
      `View ${quote(name)} is not one that elt made: it does not begin with ${head}`,
    );
  return renamed.slice(head.length);
}
