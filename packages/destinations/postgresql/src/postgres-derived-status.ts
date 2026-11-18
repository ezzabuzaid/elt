import type postgres from 'postgres';

import type { PipelineClock } from '@eltjs/elt';

import { type Queries, lockSchema } from './postgres-session.ts';

// One row for each derived dataset of the database: what its refreshes left,
// which readers see through marts.derived_status. The sync history makes it
// with its tables, and a dataset makes it too, so it never depends on the
// order of the two.
export const derivedStatusTable = `CREATE TABLE IF NOT EXISTS _warehouse.derived_status (
    dataset text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('view', 'computed')),
    state text NOT NULL CHECK (state IN ('waiting', 'refreshing', 'current', 'failed')),
    as_of timestamptz, refreshed_at timestamptz, refreshing_since timestamptz, error text,
    inputs bigint, computed bigint, empty bigint, failed bigint, pending bigint
  )`;

// The counts of a computed dataset's rows, as its refresh tells them.
export type DerivedCounts = {
  readonly inputs: number;
  readonly computed: number;
  readonly empty: number;
  readonly failed: number;
  readonly pending: number;
};

// What one refresh of a derived dataset tells readers, as Snowflake keeps the
// state and DATA_TIMESTAMP of each dynamic table, and pgai the pending items
// of each vectorizer. A refresh that begins keeps as_of, the data of the
// last refresh that ended, until it ends too. dataset is the name with its
// schema.
export class PostgresDerivedStatus {
  readonly #sql: postgres.Sql;
  readonly #dataset: string;
  readonly #kind: 'view' | 'computed';
  readonly #clock: PipelineClock;
  // When this refresh began to read, which its end gives as as_of.
  readonly #since: string;

  // sql is a session outside any transaction, between the dataset's own.
  constructor(
    sql: postgres.Sql,
    dataset: string,
    kind: 'view' | 'computed',
    clock: PipelineClock,
  ) {
    this.#sql = sql;
    this.#dataset = dataset;
    this.#kind = kind;
    this.#clock = clock;
    this.#since = this.#now();
  }

  waiting(): Promise<void> {
    return this.#write({ state: 'waiting', refreshing_since: null });
  }

  refreshing(counts: DerivedCounts): Promise<void> {
    return this.#write({
      state: 'refreshing',
      refreshing_since: this.#since,
      ...counts,
    });
  }

  // Inside the transaction of a commit that settled count inputs.
  async settled(sql: Queries, count: number): Promise<void> {
    await sql.unsafe(
      'UPDATE _warehouse.derived_status SET pending = GREATEST(pending - $1, 0) WHERE dataset = $2',
      [count, this.#dataset],
    );
  }

  current(counts?: DerivedCounts): Promise<void> {
    return this.#write({
      state: 'current',
      as_of: this.#since,
      refreshed_at: this.#now(),
      refreshing_since: null,
      error: null,
      ...counts,
    });
  }

  failed(error: string): Promise<void> {
    return this.#write({ state: 'failed', refreshing_since: null, error });
  }

  // In a transaction of its own, which takes no commit number: the status is
  // no data of a position.
  async #write(
    values: Readonly<Record<string, string | number | null>>,
  ): Promise<void> {
    const columns = ['dataset', 'kind', ...Object.keys(values)];
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    const assignments = columns
      .slice(1)
      .map((column) => `${column} = excluded.${column}`);
    await this.#sql.begin(async (sql) => {
      await lockSchema(sql, '_warehouse');
      await sql.unsafe(derivedStatusTable);
      await sql.unsafe(
        `INSERT INTO _warehouse.derived_status (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (dataset) DO UPDATE SET ${assignments.join(', ')}`,
        [this.#dataset, this.#kind, ...Object.values(values)],
      );
    });
  }

  #now(): string {
    return new Date(this.#clock.Date.now()).toISOString();
  }
}
