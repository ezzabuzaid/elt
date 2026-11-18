import type { DatabaseSync } from 'node:sqlite';

import { Declaration } from '@zukhruf/sqlite-drift';
import { transaction } from '@zukhruf/sqlite-transaction';

import type { PipelineClock } from '@eltjs/elt';

export const derivedStatus = '"_elt_derived_status"';

// One row for each derived dataset of the file: what its refreshes left,
// which readers see through the view derived_status. The sync history makes
// it with its tables, and a dataset in a file that no connection loads makes
// it itself.
export const derivedStatusTable = `CREATE TABLE ${derivedStatus} (
    "dataset" TEXT PRIMARY KEY,
    "kind" TEXT NOT NULL CHECK ("kind" IN ('view', 'computed')),
    "state" TEXT NOT NULL CHECK ("state" IN ('waiting', 'refreshing', 'current', 'failed')),
    "as_of" TEXT, "refreshed_at" TEXT, "refreshing_since" TEXT, "error" TEXT,
    "inputs" INTEGER, "computed" INTEGER, "empty" INTEGER, "failed" INTEGER, "pending" INTEGER
  ) STRICT`;

const declaration = new Declaration([derivedStatusTable], { rows: 'replace' });

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
// last refresh that ended, until it ends too.
export class SQLiteDerivedStatus {
  readonly #database: DatabaseSync;
  readonly #dataset: string;
  readonly #kind: 'view' | 'computed';
  readonly #clock: PipelineClock;
  // When this refresh began to read, which its end gives as as_of.
  readonly #since: string;

  constructor(
    database: DatabaseSync,
    dataset: string,
    kind: 'view' | 'computed',
    clock: PipelineClock,
  ) {
    this.#database = database;
    this.#dataset = dataset;
    this.#kind = kind;
    this.#clock = clock;
    this.#since = this.#now();
  }

  waiting(): void {
    this.#write({ state: 'waiting', refreshing_since: null });
  }

  refreshing(counts: DerivedCounts): void {
    this.#write({
      state: 'refreshing',
      refreshing_since: this.#since,
      ...counts,
    });
  }

  // Inside the transaction of a commit that settled count inputs.
  settled(count: number): void {
    this.#database
      .prepare(
        `UPDATE ${derivedStatus} SET "pending" = max("pending" - ?, 0) WHERE "dataset" = ?`,
      )
      .run(count, this.#dataset);
  }

  current(counts?: DerivedCounts): void {
    this.#write({
      state: 'current',
      as_of: this.#since,
      refreshed_at: this.#now(),
      refreshing_since: null,
      error: null,
      ...counts,
    });
  }

  failed(error: string): void {
    this.#write({ state: 'failed', refreshing_since: null, error });
  }

  #write(values: Readonly<Record<string, string | number | null>>): void {
    transaction(
      this.#database,
      () => {
        declaration.apply(this.#database);
        const columns = ['dataset', 'kind', ...Object.keys(values)];
        const names = columns.map((column) => `"${column}"`);
        const placeholders = columns.map(() => '?');
        const assignments = names
          .slice(1)
          .map((name) => `${name} = excluded.${name}`);
        this.#database
          .prepare(
            `INSERT INTO ${derivedStatus} (${names.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT ("dataset") DO UPDATE SET ${assignments.join(', ')}`,
          )
          .run(this.#dataset, this.#kind, ...Object.values(values));
      },
      { mode: 'immediate' },
    );
  }

  #now(): string {
    return new Date(this.#clock.Date.now()).toISOString();
  }
}
