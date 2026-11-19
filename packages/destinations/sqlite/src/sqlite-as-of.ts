import { type DatabaseSync, type SQLInputValue, constants } from 'node:sqlite';

import { UnavailableError, open } from '@zukhruf/sqlite-open';

import {
  type Position,
  parsePosition,
  readingExpiry,
  staleness,
} from '@eltjs/elt';

import { busyTimeout } from './open-destination.ts';
import { derivedStatus } from './sqlite-derived-status.ts';
import { histories } from './sqlite-history.ts';
import { identifiers, internalColumns, quote } from './sqlite-identifiers.ts';
import { committedAt, readNumbering, sqliteFile } from './sqlite-loads.ts';
import { attempts, checks, coverage } from './sqlite-sync-history-schema.ts';

type Versioned = { readonly target: string; readonly history: string };

/**
 * The SQL functions that views of a position call to fail, by name: a host
 * registers each one on the connection that reads the views, as
 * `database.function(name, implementation)`. `_elt_unversioned` refuses a
 * read of what keeps no row versions; `_elt_readable` refuses a read of a
 * position that the attached file no longer reads exactly.
 */
export const asOfFunctions = {
  _elt_unversioned(reason: SQLInputValue): never {
    throw new Error(String(reason));
  },
  // The guard knows the epoch, min_valid and expired_by of the file only: a
  // file made again has another epoch.
  _elt_readable(
    schema: SQLInputValue,
    position: SQLInputValue,
    epoch: SQLInputValue,
    minValid: SQLInputValue,
    expiredBy: SQLInputValue,
  ): 1 {
    const asked = parsePosition(String(position), sqliteFile);
    const expired = staleness(
      {
        epoch: String(epoch),
        minValid: Number(minValid),
        expiredBy:
          expiredBy === 'retention' || expiredBy === 'clear' ? expiredBy : null,
      },
      asked,
      sqliteFile,
    );
    if (expired === undefined) return 1;
    throw new Error(`${expired} (the file attached as ${String(schema)})`);
  },
};

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
  const asked =
    position === undefined ? undefined : parsePosition(position, sqliteFile);
  const database = reader(path);
  if (database === null) return { expired: `No load has committed to ${path}` };
  using stack = new DisposableStack();
  stack.use(database);
  database.exec('BEGIN');
  const numbered = readNumbering(database);
  if (asked !== undefined) {
    const expired = readingExpiry(numbered, asked, sqliteFile, path);
    if (expired !== undefined) return { expired };
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
  shadow(database, number, number < numbered.settled);
  stack.move();
  return {
    sql: database,
    position: `${numbered.epoch}:${number}`,
    at: Temporal.Instant.from(at),
    [Symbol.dispose]: () => database.close(),
  };
}

// Shadows, for this connection, each target with a TEMP view of what it
// showed as of commit number, with the columns a reader sees, so a reading
// shows the same columns at each position. Before the newest commit, each
// other name a reader queries is shadowed too. A TEMP view takes the place of
// a table or view of main for an unqualified name, and SQLite resolves the
// names of a view when it is read, so the views can be made in any order.
function shadow(database: DatabaseSync, number: number, past: boolean): void {
  const targets = versioned(database, 'main');
  for (const version of targets)
    database.exec(
      `CREATE TEMP VIEW ${quote(version.target)} AS ${selectAsOf(database, version, number, 'main')}`,
    );
  // At the newest commit, the views and the sync history read the file as
  // it is.
  if (!past) return;
  database.function('_elt_unversioned', asOfFunctions._elt_unversioned);
  for (const view of syncHistoryViews(database, 'main', (table) => table))
    database.exec(view);
  const views = storedViews(database, 'main');
  for (const { sql } of views)
    database.exec(sql.replace(/^CREATE VIEW /, 'CREATE TEMP VIEW '));
  refuseQualified(
    database,
    views.map(({ name }) => name),
    new Set(targets.map(({ target }) => identifiers.key(target))),
  );
}

/**
 * The SELECT that reads one target of the file as of a position, for a reader
 * that copies the target, such as into a database of its own: the current
 * rows that the commit of the position had made, and the history rows that it
 * had made and a later commit replaced, with the columns of the stream and
 * `loaded_at`, or of a computed dataset, and none of the internal columns
 * that only the destination reads. `schema` names the file where
 * `database` attached it, main by default. Run the SELECT in the read
 * transaction that this checks the position in, since a later commit can
 * expire the position. A position of another epoch, past the newest commit,
 * or older than the retention, is expired.
 */
export function asOfSelect(
  database: DatabaseSync,
  target: string,
  position: string,
  { schema = 'main' }: { readonly schema?: string } = {},
): string | { readonly expired: string } {
  const asked = readable(database, position, schema);
  if ('expired' in asked) return asked;
  const version = versioned(database, schema).find(
    (version) => identifiers.key(version.target) === identifiers.key(target),
  );
  if (version === undefined)
    throw new TypeError(`${quote(target)} is not a target of ${schema}`);
  return selectAsOf(database, version, asked.number, schema);
}

// The position, when the file attached as schema reads it now.
export function readable(
  database: DatabaseSync,
  position: string,
  schema: string,
): Position | { readonly expired: string } {
  const asked = parsePosition(position, sqliteFile);
  const expired = readingExpiry(
    readNumbering(database, schema),
    asked,
    sqliteFile,
    schema === 'main' ? 'the file' : `the file attached as ${schema}`,
  );
  if (expired !== undefined) return { expired };
  return asked;
}

// A target as of commit number: its current rows that the commit had made,
// and the history rows that the commit had made and a later commit replaced,
// with the columns a reader sees, none of the internal ones. A column
// that the history lacks reads as NULL there. A guarded select is for a view
// that outlives the read transaction: each read first checks, in the same
// statement, that the file still reads the position exactly.
export function selectAsOf(
  database: DatabaseSync,
  { target, history }: Versioned,
  number: number,
  schema: string,
  guard?: Position,
): string {
  const columns = columnsOf(database, quote(target), schema).filter(
    (column) => !internalColumns.includes(identifiers.key(column)),
  );
  const kept = new Set(
    columnsOf(database, quote(history), schema).map((column) =>
      identifiers.key(column),
    ),
  );
  const current = columns.map((column) => `"r".${quote(column)}`).join(', ');
  const replaced = columns
    .map((column) =>
      kept.has(identifiers.key(column))
        ? `"r".${quote(column)}`
        : `NULL AS ${quote(column)}`,
    )
    .join(', ');
  const file = quote(schema);
  // The guard is the outer loop of a CROSS JOIN, which SQLite keeps in
  // place, so it runs once and also when the target holds no row.
  const from =
    guard === undefined
      ? (table: string) => `FROM ${file}.${quote(table)} AS "r" WHERE`
      : (table: string) =>
          `FROM ${file}."_elt_epoch" AS "e" CROSS JOIN ${file}.${quote(table)} AS "r" WHERE "_elt_readable"(${literal(schema)}, ${literal(`${guard.epoch}:${guard.number}`)}, "e"."epoch", "e"."min_valid", "e"."expired_by") AND`;
  return `SELECT ${current} ${from(target)} "r"."committed_in" <= ${number} UNION ALL SELECT ${replaced} ${from(history)} "r"."committed_in" <= ${number} AND "r"."replaced_in" > ${number}`;
}

export const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

// The tables of the sync history, unquoted.
export const syncHistoryTables = [
  attempts,
  coverage,
  checks,
  derivedStatus,
].map((table) => table.slice(1, -1));

// The sync history keeps no versions, so each of its tables of schema reads
// as a TEMP view, named by name, that fails, and so does each view over them.
export function syncHistoryViews(
  database: DatabaseSync,
  schema: string,
  name: (table: string) => string,
): string[] {
  return syncHistoryTables.flatMap((table) => {
    const columns = columnsOf(database, quote(table), schema);
    return columns.length === 0
      ? []
      : [
          `CREATE TEMP VIEW ${quote(name(table))} AS SELECT ${columns.map((column) => `NULL AS ${quote(column)}`).join(', ')} WHERE "_elt_unversioned"('The sync history cannot be read as of a position: it keeps no row versions')`,
        ];
  });
}

export function storedViews(
  database: DatabaseSync,
  schema: string,
): { readonly name: string; readonly sql: string }[] {
  return database
    .prepare(
      String.raw`SELECT "name", "sql" FROM ${quote(schema)}.sqlite_schema WHERE "type" = 'view' AND "name" NOT LIKE 'sqlite\_%' ESCAPE '\'`,
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

// Each target with its history, as the file attached as schema records them.
export function versioned(database: DatabaseSync, schema: string): Versioned[] {
  const file = quote(schema);
  if (
    database
      .prepare(
        `SELECT 1 FROM ${file}.sqlite_schema WHERE "type" = 'table' AND "name" = ?`,
      )
      .get(histories) === undefined
  )
    return [];
  return database
    .prepare(
      `SELECT t."name" AS "target", h."history" FROM ${file}.${quote(histories)} AS h JOIN ${file}.sqlite_schema AS t ON t."type" = 'table' AND lower(t."name") = h."target" JOIN ${file}.sqlite_schema AS k ON k."type" = 'table' AND k."name" = h."history"`,
    )
    .all()
    .map(({ target, history }) => ({
      target: String(target),
      history: String(history),
    }));
}

// The columns of a table of schema, named as SQL quotes it.
export function columnsOf(
  database: DatabaseSync,
  table: string,
  schema = 'main',
): string[] {
  return database
    .prepare(`PRAGMA ${quote(schema)}.table_info(${table})`)
    .all()
    .map(({ name }) => String(name));
}
