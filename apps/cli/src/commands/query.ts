import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { Argument, type Command as Declaration } from 'commander';
import type { AppleApp } from '../apps/apple-app.ts';
import type { Store } from '../store.ts';
import { table } from '../table.ts';
import { Command, type Output } from './command.ts';

type QueryResult = {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
};

type ViewSummary = {
  readonly view: string;
  readonly rows: number;
  readonly coverage: string;
};

// Nothing a query runs can write to an app's data.sqlite.
function open(store: Store, { name, title }: AppleApp): DatabaseSync {
  if (!store.selections().some((selection) => selection.app === name))
    throw new Error(`${title} is not set up; run: setup`);
  if (!existsSync(store.database(name)))
    throw new Error(`${title} has not synced yet; run: sync`);
  return store.read(name);
}

// One statement, read-only; SQLite would otherwise run the first statement
// and silently drop the rest.
function query(store: Store, app: AppleApp, sql: string): QueryResult {
  using database = open(store, app);
  const statement = database.prepare(sql);
  if (holdsStatement(database, sql.slice(statement.sourceSQL.length)))
    throw new Error('Run one SQL statement at a time');
  statement.setReturnArrays(true);
  return {
    columns: statement.columns().map(({ name }) => name),
    rows: statement.all() as unknown as unknown[][],
  };
}

// SQLite judges what follows the first statement: only whitespace, comments
// and semicolons leave nothing to prepare, while anything else, even a
// malformed statement, is another statement.
function holdsStatement(database: DatabaseSync, rest: string): boolean {
  try {
    database.prepare(rest);
    return true;
  } catch (error) {
    return Object(error).code !== 'ERR_INVALID_ARG_VALUE';
  }
}

// What an app's file holds for readers: each stream's view, how many rows it
// has, and what the latest pass declared it covers.
function views(store: Store, app: AppleApp): ViewSummary[] {
  using database = open(store, app);
  const streams = database
    .prepare(
      `SELECT s.stream, c.description FROM stream_status s
       JOIN extraction_coverage c ON c.attempt_id = s.latest_attempt_id AND c.stream = s.stream
       WHERE s.connector = ? ORDER BY s.stream`,
    )
    .all(app.name) as { stream: string; description: string }[];
  // A stream whose table was never prepared, such as one denied before its
  // first load, has a status but no view.
  const readable = new Set(
    (
      database
        .prepare("SELECT name FROM catalog WHERE kind = 'view'")
        .all() as {
        name: string;
      }[]
    ).map(({ name }) => name),
  );
  return streams
    .map(({ stream, description }) => ({
      view: app.view(stream),
      coverage: description,
    }))
    .filter(({ view }) => readable.has(view))
    .map(({ view, coverage }) => ({
      view,
      coverage,
      rows: (
        database.prepare(`SELECT count(*) AS n FROM "${view}"`).get() as {
          n: number;
        }
      ).n,
    }));
}

export class QueryCommand extends Command {
  readonly name = 'query';
  readonly summary =
    "Run one read-only SQL statement on an app's data, or list its views with --tables";

  constructor(
    apps: readonly AppleApp[],
    readonly store: Store,
  ) {
    super(apps);
  }

  protected configure(declaration: Declaration): void {
    declaration
      .addArgument(new Argument('<app>').choices(this.appNames))
      .argument(
        '[sql]',
        'one statement; the catalog view lists every view and column: SELECT name, data_type, description FROM catalog',
      )
      .option('--tables', "list each stream's view, its rows and coverage");
  }

  protected async run(declaration: Declaration): Promise<Output> {
    const [name, sql] = declaration.processedArgs as [
      string,
      string | undefined,
    ];
    const app = this.app(name);
    if (declaration.opts().tables === true) {
      const summaries = views(this.store, app);
      return {
        data: summaries,
        text: () =>
          table(
            ['View', 'Rows', 'Coverage'],
            summaries.map(({ view, rows, coverage }) => [view, rows, coverage]),
          ),
      };
    }
    if (sql === undefined)
      throw new Error('Give one SQL statement, or --tables');
    const { columns, rows } = query(this.store, app, sql);
    return {
      data: rows.map((row) =>
        Object.fromEntries(columns.map((name, at) => [name, row[at]])),
      ),
      text: () =>
        `${table(columns, rows)}\n${rows.length} row${rows.length === 1 ? '' : 's'}`,
    };
  }
}
