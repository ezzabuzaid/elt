import postgres from 'postgres';

import { type Connection, DerivedDataset } from '@eltjs/elt';

import { PostgresDestination } from './postgres-destination.ts';
import { PostgresSession } from './postgres-session.ts';
import type { PostgresTable } from './postgres-table.ts';
import {
  type PostgresView,
  checkView,
  publishPostgresViews,
} from './postgres-views.ts';

// A view over what the pipeline loads into one Postgres database: derived
// data that Postgres computes on each read, as a dbt model materialized as a
// view is. It lives in the schema of into, where its SQL's bare names resolve
// too. Its inputs are the relations its SQL reads, so it names none of them.
// It appears once its query compiles, so a reader never finds a view that
// fails; until a copy of the pipeline has made each relation it reads, and
// each derived dataset before it that it reads has appeared, it waits, as dbt
// skips a model whose upstream model was skipped. Any other error of its
// query is the view's own failure.
export class View extends DerivedDataset<PostgresTable> {
  readonly name: string;
  // The database and schema the view lives in, where a computed dataset
  // after it reads it.
  readonly into: PostgresDestination;
  readonly #view: PostgresView;

  constructor({
    into,
    name,
    description,
    columns,
    sql,
  }: {
    into: PostgresDestination;
    name: string;
    description: string;
    columns: Readonly<Record<string, string>>;
    sql: string;
  }) {
    super();
    this.name = name;
    this.into = into;
    this.#view = { name, description, columns, query: sql };
    checkView(this.#view);
    Object.freeze(this);
  }

  get qualifiedName(): string {
    return `${this.into.schema}.${this.name}`;
  }

  override validate(connections: readonly Connection<PostgresTable>[]): void {
    if (made(connections, this.into).has(this.qualifiedName))
      throw new TypeError(
        `View ${this.qualifiedName} has the name of a table or reader view a copy makes`,
      );
  }

  override async refresh({
    connections,
    earlier,
  }: {
    readonly connections: readonly Connection<PostgresTable>[];
    readonly earlier: readonly DerivedDataset<PostgresTable>[];
  }): Promise<void> {
    await using session = new PostgresSession(this.into.url, 'elt-derived');
    try {
      await session.sql.begin((transaction) =>
        publishPostgresViews(transaction, {
          schema: this.into.schema,
          views: [this.#view],
        }),
      );
    } catch (error) {
      const missing = missingRelation(error, this.into.schema);
      if (
        missing !== undefined &&
        (made(connections, this.into).has(missing) ||
          earlier.some((dataset) => derivedRelation(dataset) === missing))
      )
        return;
      throw error;
    }
  }
}

// The schema-qualified relation that Postgres found missing, with a bare name
// resolved in the schema the view's SQL reads bare names from.
function missingRelation(error: unknown, schema: string): string | undefined {
  if (!(error instanceof postgres.PostgresError) || error.code !== '42P01')
    return undefined;
  const name = /^relation "(.+)" does not exist$/.exec(error.message)?.[1];
  if (name === undefined) return undefined;
  return name.includes('.') ? name : `${schema}.${name}`;
}

// The tables and reader views that the pipeline's copies make in the
// database of into, schema-qualified.
export function made(
  connections: readonly Connection<PostgresTable>[],
  into: PostgresDestination,
): Set<string> {
  return new Set(
    connections.flatMap(({ destination, steps }) =>
      destination instanceof PostgresDestination && destination.url === into.url
        ? steps.flatMap(({ to }) => [
            `${destination.schema}.${to.name}`,
            ...(to.readerView === undefined
              ? []
              : [`${to.readerView.schema}.${to.readerView.name}`]),
          ])
        : [],
    ),
  );
}

// The relation that a derived dataset of this package makes for readers.
function derivedRelation(
  dataset: DerivedDataset<PostgresTable>,
): string | undefined {
  return 'qualifiedName' in dataset && typeof dataset.qualifiedName === 'string'
    ? dataset.qualifiedName
    : undefined;
}
