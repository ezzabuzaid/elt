import { type DatabaseSync, constants } from 'node:sqlite';

import { UnavailableError, open } from '@zukhruf/sqlite-open';

import { busyTimeout } from './open-destination.ts';
import { histories } from './sqlite-history.ts';
import { identifiers } from './sqlite-identifiers.ts';
import {
  committedAt,
  expiry,
  parsePosition,
  readNumbering,
} from './sqlite-loads.ts';
import { attempts, checks, coverage } from './sqlite-sync-history-schema.ts';

type Versioned = { readonly target: string; readonly history: string };

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * The SQLite file as of one position: `sql` reads in one read transaction,
 * and sees each target as it was at that position. Dispose it to close it.
 */
export type SQLiteReading = {
  readonly sql: DatabaseSync;
  readonly position: string;
  // When the commit of the position was made.
  readonly at: Temporal.Instant;
} & Disposable;

// A reader of the file, or null while no file is at the path.
export function reader(path: string): DatabaseSync | null {
  try {
    return open(path, { readOnly: true, timeout: busyTimeout });
  } catch (error) {
    if (error instanceof UnavailableError) return null;
    throw error;
  }
}

// Reads the file as of the position, or as of its newest position. One read
// transaction holds the snapshot that the numbering and every later read
// see, so a commit after the reading begins shows in none of them.
export function readAsOf(
  path: string,
  position: string | undefined,
): SQLiteReading | { readonly expired: string } {
  const asked = position === undefined ? undefined : parsePosition(position);
  const database = reader(path);
  if (database === null) return { expired: `No load has committed to ${path}` };
  using stack = new DisposableStack();
  stack.use(database);
  database.exec('BEGIN');
  const numbered = readNumbering(database);
  if (asked !== undefined) {
    const expired = expiry(numbered, asked);
    if (expired !== undefined) return { expired };
    // No later load can straddle a position, so one that a reader was given
    // stays one; a commit that is not a position stays inside its pass.
    if (!numbered?.ends.includes(asked.number))
      throw new TypeError(
        `${position} is not a position of ${path}: a reading of a commit inside a pass would show a part of that pass. Read a position that positions() lists.`,
      );
  }
  const number = asked?.number ?? numbered?.ends.at(-1);
  const at = number === undefined ? undefined : committedAt(database, number);
  if (numbered === null || number === undefined || at === undefined)
    return {
      expired:
        position === undefined
          ? `${path} has no position yet`
          : `Position ${position} names no commit of ${path}`,
    };
  if (number < numbered.newest) shadow(database, number);
  stack.move();
  return {
    sql: database,
    position: `${numbered.epoch}:${number}`,
    at: Temporal.Instant.from(at),
    [Symbol.dispose]: () => database.close(),
  };
}

// Shadows, for this connection, each name a reader queries with a TEMP view
// of what it showed as of commit number. A TEMP view takes the place of a
// table or view of main for an unqualified name, and SQLite resolves the
// names of a view when it is read, so the views can be made in any order.
function shadow(database: DatabaseSync, number: number): void {
  const targets = versioned(database);
  for (const version of targets) shadowTarget(database, version, number);
  shadowSyncHistory(database);
  const views = storedViews(database);
  for (const { sql } of views)
    database.exec(sql.replace(/^CREATE VIEW /, 'CREATE TEMP VIEW '));
  refuseQualified(
    database,
    views.map(({ name }) => name),
    new Set(targets.map(({ target }) => identifiers.key(target))),
  );
}

// A target as of commit number: its current rows that the commit had made,
// and the history rows that the commit had made and a later commit replaced.
// A column that the history lacks reads as NULL there.
function shadowTarget(
  database: DatabaseSync,
  { target, history }: Versioned,
  number: number,
): void {
  const columns = columnsOf(database, quote(target));
  const kept = new Set(
    columnsOf(database, quote(history)).map((column) =>
      identifiers.key(column),
    ),
  );
  const current = columns.map(quote).join(', ');
  const replaced = columns
    .map((column) =>
      kept.has(identifiers.key(column))
        ? quote(column)
        : `NULL AS ${quote(column)}`,
    )
    .join(', ');
  database.exec(
    `CREATE TEMP VIEW ${quote(target)} AS SELECT ${current} FROM main.${quote(target)} WHERE "committed_in" <= ${number} UNION ALL SELECT ${replaced} FROM main.${quote(history)} WHERE "committed_in" <= ${number} AND "replaced_in" > ${number}`,
  );
}

// The sync history keeps no versions, so each of its tables reads as a view
// that fails, and so does each view over them.
function shadowSyncHistory(database: DatabaseSync): void {
  database.function('_elt_unversioned', { deterministic: false }, () => {
    throw new Error(
      'The sync history cannot be read as of a position: it keeps no row versions',
    );
  });
  for (const table of [attempts, coverage, checks]) {
    const columns = columnsOf(database, table);
    if (columns.length > 0)
      database.exec(
        `CREATE TEMP VIEW ${table} AS SELECT ${columns.map((column) => `NULL AS ${quote(column)}`).join(', ')} WHERE "_elt_unversioned"()`,
      );
  }
}

function storedViews(
  database: DatabaseSync,
): { readonly name: string; readonly sql: string }[] {
  return database
    .prepare(
      String.raw`SELECT "name", "sql" FROM main.sqlite_schema WHERE "type" = 'view' AND "name" NOT LIKE 'sqlite\_%' ESCAPE '\'`,
    )
    .all()
    .map(({ name, sql }) => ({ name: String(name), sql: String(sql) }));
}

// Refuses a stored view that reads a versioned target as main."target": the
// name skips the TEMP view of the target, so the view would show the target
// as it is now. SQLite tells which view reads each table while it prepares a
// statement, so each view is prepared once with an authorizer that watches.
function refuseQualified(
  database: DatabaseSync,
  views: readonly string[],
  targets: ReadonlySet<string>,
): void {
  let found: { readonly view: string; readonly target: string } | undefined;
  database.setAuthorizer((action, table, _column, schema, view) => {
    if (
      action === constants.SQLITE_READ &&
      schema === 'main' &&
      table !== null &&
      targets.has(identifiers.key(table)) &&
      identifiers.key(view ?? '') !== identifiers.key(table)
    )
      found ??= { view: view ?? '', target: table };
    return constants.SQLITE_OK;
  });
  try {
    for (const view of views) {
      try {
        database.prepare(`SELECT * FROM temp.${quote(view)}`);
      } catch {
        // A view that fails to prepare fails when it is read, too.
      }
      if (found !== undefined)
        throw new TypeError(
          `View ${quote(found.view)} reads ${quote(found.target)} as main.${quote(found.target)}, which shows it as it is now, not as of a position; name the table without main.`,
        );
    }
  } finally {
    database.setAuthorizer(null);
  }
}

// Each target with its history, as the file records them.
function versioned(database: DatabaseSync): Versioned[] {
  if (
    database
      .prepare(
        `SELECT 1 FROM main.sqlite_schema WHERE "type" = 'table' AND "name" = ?`,
      )
      .get(histories) === undefined
  )
    return [];
  return database
    .prepare(
      `SELECT t."name" AS "target", h."history" FROM ${quote(histories)} AS h JOIN main.sqlite_schema AS t ON t."type" = 'table' AND lower(t."name") = h."target" JOIN main.sqlite_schema AS k ON k."type" = 'table' AND k."name" = h."history"`,
    )
    .all()
    .map(({ target, history }) => ({
      target: String(target),
      history: String(history),
    }));
}

// The columns of a table of main, named as SQL quotes it.
function columnsOf(database: DatabaseSync, table: string): string[] {
  return database
    .prepare(`PRAGMA main.table_info(${table})`)
    .all()
    .map(({ name }) => String(name));
}
