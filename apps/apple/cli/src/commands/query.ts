import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { Argument, type Command as Declaration } from 'commander';

import type { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';

import { table } from '../table.ts';
import { Command, type Output } from './command.ts';

type QueryResult = {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
};

type ViewSummary = {
  readonly view: string;
  // Not counted for a preset, which can be as slow to read as a query.
  readonly rows: number | null;
  readonly coverage: string;
};

// One statement, read-only; SQLite would otherwise run the first statement
// and silently drop the rest.
function query(database: DatabaseSync, sql: string): QueryResult {
  const statement = database.prepare(sql);
  if (holdsStatement(database, sql.slice(statement.sourceSQL.length)))
    throw new Error('Run one SQL statement at a time');
  statement.setReturnArrays(true);
  return {
    columns: statement.columns().map(({ name }) => name),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- @types/node types rows as objects even though setReturnArrays(true) makes them arrays
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

// What a connector's file holds for readers: each stream's view, how many
// rows it has, and what the latest pass declared it covers.
function views(
  database: DatabaseSync,
  connector: AppleConnector,
): ViewSummary[] {
  const streams = database
    .prepare(
      `SELECT s.stream, c.description FROM stream_status s
       JOIN extraction_coverage c ON c.attempt_id = s.latest_attempt_id AND c.stream = s.stream
       WHERE s.connector = ? ORDER BY s.stream`,
    )
    .all(connector.name)
    .map((row) => ({
      stream: String(row.stream),
      description: String(row.description),
    }));
  // A stream whose table was never prepared, such as one denied before its
  // first load, has a status but no view.
  const readable = new Set(
    database
      .prepare("SELECT name FROM catalog WHERE kind = 'view'")
      .all()
      .map(({ name }) => String(name)),
  );
  return streams
    .map(({ stream, description }) => ({
      view: connector.view(stream),
      coverage: description,
    }))
    .filter(({ view }) => readable.has(view))
    .map(({ view, coverage }) => ({
      view,
      coverage,
      rows: Number(
        database.prepare(`SELECT count(*) AS n FROM "${view}"`).get()?.n,
      ),
    }));
}

// The connector's presets, created as temporary views on this connection only,
// so a statement reads them like any view and the import stays unchanged.
function loadPresets(database: DatabaseSync, connector: AppleConnector): void {
  for (const { file } of connector.presets())
    try {
      database.exec(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`The preset ${file} does not load`, { cause: error });
    }
}

export class QueryCommand extends Command {
  readonly name = 'query';
  readonly summary =
    "Run one read-only SQL statement on a connector's data, or list its views with --tables";

  protected configure(declaration: Declaration): void {
    declaration
      .addArgument(new Argument('<connector>').choices(this.imports.names))
      .argument(
        '[sql]',
        "one statement; the catalog view lists every view and column: SELECT name, data_type, description FROM catalog. The connector's presets are views too, described in their files",
      )
      .option(
        '--tables',
        "list each stream's view, its rows and coverage, and the connector's presets",
      );
  }

  protected async run(declaration: Declaration): Promise<Output> {
    const name: string = declaration.processedArgs[0];
    const sql: string | undefined = declaration.processedArgs[1];
    if (declaration.opts().tables === true) {
      using database = this.imports.read(name);
      const connector = this.imports.connector(name);
      const summaries = [
        ...views(database, connector),
        ...connector.presets().map(({ name: view }) => ({
          view,
          rows: null,
          coverage: 'Preset, loaded before each query',
        })),
      ];
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
    using database = this.imports.read(name);
    loadPresets(database, this.imports.connector(name));
    const { columns, rows } = query(database, sql);
    return {
      data: rows.map((row) =>
        Object.fromEntries(columns.map((name, at) => [name, row[at]])),
      ),
      text: () =>
        `${table(columns, rows)}\n${rows.length} row${rows.length === 1 ? '' : 's'}`,
    };
  }
}
