import {
  type Connection,
  DerivedDataset,
  type PipelineClock,
  refreshView,
} from '@eltjs/elt';

import { connect, transaction } from './sql-server-connection.ts';
import { numberOf } from './sql-server-dependents.ts';
import { SqlServerDerivedStatus } from './sql-server-derived-status.ts';
import { SqlServerDestination, database } from './sql-server-destination.ts';
import { identifiers } from './sql-server-identifiers.ts';
import { marts, warehouse } from './sql-server-schemas.ts';
import type { SqlServerTable } from './sql-server-table.ts';
import {
  type SqlServerView,
  publishViews,
  withdrawView,
} from './sql-server-views.ts';

// The error of a relation that no schema has: CREATE VIEW over it fails with
// it. A relation that goes away after the view was made fails each read of
// the view with 4413 instead (ADR 0006).
const invalidObject = 208;

// A view over what the pipeline loads into one SQL Server database: derived
// data that SQL Server computes on each read, as a dbt model materialized as
// a view is. It lives in marts, where its SQL's bare names resolve first, and
// then in dbo, so it reads reader views. Its inputs are the relations its
// SQL reads, so it names none of them. It appears, or waits, as refreshView
// of elt says.
export class View extends DerivedDataset<SqlServerTable> {
  readonly name: string;
  // The database the view lives in, where a computed dataset after it reads
  // it.
  readonly into: SqlServerDestination;
  readonly #view: SqlServerView;

  constructor({
    into,
    name,
    description,
    columns,
    sql,
  }: {
    into: SqlServerDestination;
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

  get qualifiedName(): string {
    return `${marts}.${this.name}`;
  }

  override validate(connections: readonly Connection<SqlServerTable>[]): void {
    if (made(connections, this.into).has(identifiers.key(this.qualifiedName)))
      throw new TypeError(
        `View ${this.qualifiedName} has the name of a table or reader view a copy makes`,
      );
  }

  override async refresh({
    connections,
    earlier,
    clock,
  }: {
    readonly connections: readonly Connection<SqlServerTable>[];
    readonly earlier: readonly DerivedDataset<SqlServerTable>[];
    readonly clock: PipelineClock;
  }): Promise<void> {
    await using connection = await connect(this.into[database]);
    await refreshView({
      publish: () =>
        transaction(connection, () => publishViews(connection, [this.#view])),
      missing: missingRelation,
      awaited: new Set([
        ...made(connections, this.into),
        ...earlier.flatMap((dataset) => derivedRelation(dataset) ?? []),
      ]),
      withdraw: () =>
        transaction(connection, () => withdrawView(connection, this.name)),
      status: new SqlServerDerivedStatus(
        connection,
        this.qualifiedName,
        'view',
        clock,
      ),
    });
  }
}

// The schema-qualified relation that SQL Server found missing, in lower case,
// as the database compares names, with a bare name resolved in marts, where
// the view's SQL reads bare names from first. The message names the relation
// without brackets, as [_warehouse].[raw_x] gives '_warehouse.raw_x' (probe
// of 2026-11-20).
function missingRelation(error: unknown): string | undefined {
  if (numberOf(error) !== invalidObject || !Error.isError(error))
    return undefined;
  const name = /^Invalid object name '(.+)'\.$/.exec(error.message)?.[1];
  if (name === undefined) return undefined;
  return identifiers.key(name.includes('.') ? name : `${marts}.${name}`);
}

// The reader views in marts and the raw tables in _warehouse that the
// pipeline's copies make in the database of into, schema-qualified and in
// lower case.
function made(
  connections: readonly Connection<SqlServerTable>[],
  into: SqlServerDestination,
): Set<string> {
  const { location } = into[database];
  return new Set(
    connections.flatMap(({ destination, steps }) =>
      destination instanceof SqlServerDestination &&
      destination[database].location === location
        ? steps.flatMap(({ to }) =>
            [`${marts}.${to.name}`, `${warehouse}.${to.raw}`].map(
              identifiers.key,
            ),
          )
        : [],
    ),
  );
}

// The relation that a derived dataset of this package makes for readers, in
// lower case.
function derivedRelation(
  dataset: DerivedDataset<SqlServerTable>,
): string | undefined {
  return 'qualifiedName' in dataset && typeof dataset.qualifiedName === 'string'
    ? identifiers.key(dataset.qualifiedName)
    : undefined;
}
