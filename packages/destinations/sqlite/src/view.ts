import {
  type Connection,
  DerivedDataset,
  type PipelineClock,
  refreshView,
} from '@eltjs/elt';

import { openDestination } from './open-destination.ts';
import { SQLiteDerivedStatus } from './sqlite-derived-status.ts';
import { SQLiteDestination } from './sqlite-destination.ts';
import type { SQLiteTable } from './sqlite-table.ts';
import { type SQLiteView, publishSQLiteViews } from './sqlite-views.ts';

// A view over what the pipeline loads into one SQLite file: derived data
// that SQLite computes on each read, as a dbt model materialized as a view
// is. Its inputs are the relations its SQL reads, so it names none of them.
// It appears, or waits, as refreshView of elt says.
export class View extends DerivedDataset<SQLiteTable> {
  readonly name: string;
  // The SQLite file the view lives in, where a computed dataset after it
  // reads it.
  readonly into: SQLiteDestination;
  readonly #view: SQLiteView;

  constructor({
    into,
    name,
    description,
    columns,
    sql,
  }: {
    into: SQLiteDestination;
    name: string;
    description: string;
    columns: Readonly<Record<string, string>>;
    sql: string;
  }) {
    super();
    this.name = name;
    this.into = into;
    this.#view = { name, description, columns, query: sql };
    Object.freeze(this);
  }

  override validate(connections: readonly Connection<SQLiteTable>[]): void {
    if (this.#made(connections).has(this.name.toLowerCase()))
      throw new TypeError(
        `View ${this.name} has the name of a table or reader view a copy makes`,
      );
  }

  override async refresh({
    connections,
    earlier,
    clock,
  }: {
    readonly connections: readonly Connection<SQLiteTable>[];
    readonly earlier: readonly DerivedDataset<SQLiteTable>[];
    readonly clock: PipelineClock;
  }): Promise<void> {
    using database = openDestination(this.into.path);
    await refreshView({
      publish: async () => {
        database.prepare(this.#view.query);
        publishSQLiteViews(database, { views: [this.#view] });
      },
      missing: (error) =>
        Error.isError(error)
          ? /^no such table: (?:main\.)?(.+)$/
              .exec(error.message)?.[1]
              ?.toLowerCase()
          : undefined,
      awaited: new Set([
        ...this.#made(connections),
        ...earlier.map(({ name }) => name.toLowerCase()),
      ]),
      status: new SQLiteDerivedStatus(database, this.name, 'view', clock),
    });
  }

  // The tables and reader views the pipeline's copies make in this view's
  // file, in lower case, as SQLite compares names.
  #made(connections: readonly Connection<SQLiteTable>[]): Set<string> {
    return new Set(
      connections
        .filter(
          ({ destination }) =>
            destination instanceof SQLiteDestination &&
            destination.path === this.into.path,
        )
        .flatMap(({ steps }) => steps)
        .flatMap(({ to }) => [to.name, to.readerView])
        .filter((name) => name !== undefined)
        .map((name) => name.toLowerCase()),
    );
  }
}
