import postgres from 'postgres';

import {
  type Connection,
  DerivedDataset,
  type PipelineClock,
  refreshView,
} from '@eltjs/elt';

import { PostgresDerivedStatus } from './postgres-derived-status.ts';
import { PostgresDestination } from './postgres-destination.ts';
import { PostgresSession } from './postgres-session.ts';
import type { PostgresTable } from './postgres-table.ts';
import {
  type PostgresView,
  checkView,
  publishPostgresViews,
  withdrawPostgresView,
} from './postgres-views.ts';

// A view over what the pipeline loads into one Postgres database: derived
// data that Postgres computes on each read, as a dbt model materialized as a
// view is. It lives in the schema of into, where its SQL's bare names resolve
// too. Its inputs are the relations its SQL reads, so it names none of them.
// It appears, or waits, as refreshView of elt says.
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
    clock,
  }: {
    readonly connections: readonly Connection<PostgresTable>[];
    readonly earlier: readonly DerivedDataset<PostgresTable>[];
    readonly clock: PipelineClock;
  }): Promise<void> {
    await using session = new PostgresSession(this.into.url, 'elt-derived');
    await refreshView({
      publish: async () => {
        await session.sql.begin((transaction) =>
          publishPostgresViews(transaction, {
            schema: this.into.schema,
            views: [this.#view],
          }),
        );
      },
      missing: (error) => missingRelation(error, this.into.schema),
      awaited: new Set([
        ...made(connections, this.into),
        ...earlier.flatMap((dataset) => derivedRelation(dataset) ?? []),
      ]),
      withdraw: async () => {
        await session.sql.begin((transaction) =>
          withdrawPostgresView(transaction, this.into.schema, this.name),
        );
      },
      status: new PostgresDerivedStatus(
        session.sql,
        this.qualifiedName,
        'view',
        clock,
      ),
    });
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
