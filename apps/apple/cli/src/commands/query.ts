import { readFileSync } from 'node:fs';

import { Argument, type Command as Declaration } from 'commander';

import type { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import { Federation } from '@workspace/sqlite-federation';

import { table } from '../table.ts';
import { Command, type Output } from './command.ts';

type ViewSummary = {
  readonly view: string;
  // Not counted for a preset, which can be as slow to read as a query.
  readonly rows: number | null;
  readonly coverage: string;
};

// What a connector's file holds for readers: each stream's view, how many
// rows it has, and what the latest pass declared it covers.
function views(database: Federation, connector: AppleConnector): ViewSummary[] {
  const streams = database.sql
    .all`SELECT s.stream, c.description FROM stream_status s
       JOIN extraction_coverage c ON c.attempt_id = s.latest_attempt_id AND c.stream = s.stream
       WHERE s.connector = ${connector.name} ORDER BY s.stream`.map((row) => ({
    stream: String(row.stream),
    description: String(row.description),
  }));
  // A stream whose table was never prepared, such as one denied before its
  // first load, has a status but no view.
  const readable = new Set(
    database.sql.all`SELECT name FROM catalog WHERE kind = 'view'`.map(
      ({ name }) => String(name),
    ),
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
        database.query(`SELECT count(*) FROM "${view}"`).rows[0]?.[0],
      ),
    }));
}

// The connector's presets, created as temporary views on this connection only,
// so a statement reads them like any view and the import stays unchanged.
function loadPresets(database: Federation, connector: AppleConnector): void {
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
    "Run one read-only SQL statement across imports, or list a connector's views with --tables";

  protected configure(declaration: Declaration): void {
    declaration
      .addArgument(new Argument('<connector>').choices(this.imports.names))
      .argument(
        '[sql]',
        "one statement; the selected connector is main, and connector.view reads another import. The catalog view lists every view and column: SELECT name, data_type, description FROM catalog. The selected connector's presets are views too, described in their files",
      )
      .option(
        '--tables',
        "list each stream's view, its rows and coverage, and the connector's presets",
      );
  }

  protected async run(declaration: Declaration): Promise<Output> {
    const name: string = declaration.processedArgs[0];
    const sql: string | undefined = declaration.processedArgs[1];
    const locate = (name: string) =>
      this.imports.names.includes(name)
        ? this.imports.database(name)
        : undefined;
    if (declaration.opts().tables === true) {
      using database = new Federation({
        main: this.imports.database(name),
        locate,
        timeout: 30_000,
      });
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
    using database = new Federation({
      main: this.imports.database(name),
      locate,
      timeout: 30_000,
    });
    loadPresets(database, this.imports.connector(name));
    const { columns, rows } = database.query(sql);
    return {
      data: rows.map((row) =>
        Object.fromEntries(columns.map((name, at) => [name, row[at]])),
      ),
      text: () =>
        `${table(columns, rows)}\n${rows.length} row${rows.length === 1 ? '' : 's'}`,
    };
  }
}
