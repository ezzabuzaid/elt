import { DatabaseSync } from 'node:sqlite';

import { type Connection, DerivedDataset } from '@workspace/elt';

import { SQLiteDestination } from './sqlite-destination.ts';
import type { SQLiteTable } from './sqlite-table.ts';
import { type SQLiteView, publishSQLiteViews } from './sqlite-views.ts';

// How long a refresh waits for a load or reader to finish committing.
const busyTimeout = 30_000;

// A view over what the pipeline loads into one SQLite file: derived data
// that SQLite computes on each read, as a dbt model materialized as a view
// is. Its inputs are the relations its SQL reads, so it names none of them.
// It appears once its query compiles, so a reader never finds a view that
// fails; until a copy of the pipeline has made each table it reads, it
// waits. Any other error of its query is the view's own failure.
export class View extends DerivedDataset<SQLiteTable> {
  readonly name: string;
  readonly #into: SQLiteDestination;
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
    this.#into = into;
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
  }: {
    readonly connections: readonly Connection<SQLiteTable>[];
  }): Promise<void> {
    using database = new DatabaseSync(this.#into.path, {
      timeout: busyTimeout,
    });
    try {
      database.prepare(this.#view.query);
    } catch (error) {
      const missing =
        error instanceof Error
          ? /^no such table: (?:main\.)?(.+)$/.exec(error.message)?.[1]
          : undefined;
      if (
        missing !== undefined &&
        this.#made(connections).has(missing.toLowerCase())
      )
        return;
      throw error;
    }
    publishSQLiteViews(database, { views: [this.#view] });
  }

  // The tables and reader views the pipeline's copies make in this view's
  // file, in lower case, as SQLite compares names.
  #made(connections: readonly Connection<SQLiteTable>[]): Set<string> {
    return new Set(
      connections
        .filter(
          ({ destination }) =>
            destination instanceof SQLiteDestination &&
            destination.path === this.#into.path,
        )
        .flatMap(({ steps }) => steps)
        .flatMap(({ to }) => [to.name, to.readerView])
        .filter((name) => name !== undefined)
        .map((name) => name.toLowerCase()),
    );
  }
}
