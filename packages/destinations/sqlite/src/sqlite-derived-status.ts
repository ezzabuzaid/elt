import type { DatabaseSync } from 'node:sqlite';

import { Declaration } from '@zukhruf/sqlite-drift';
import { transaction } from '@zukhruf/sqlite-transaction';

import { DerivedStatus, type PipelineClock } from '@eltjs/elt';

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

// The derived_status of the file: each write is a transaction of its own.
export class SQLiteDerivedStatus extends DerivedStatus {
  readonly #database: DatabaseSync;
  readonly #dataset: string;
  readonly #kind: 'view' | 'computed';

  constructor(
    database: DatabaseSync,
    dataset: string,
    kind: 'view' | 'computed',
    clock: PipelineClock,
  ) {
    super(clock);
    this.#database = database;
    this.#dataset = dataset;
    this.#kind = kind;
  }

  // Inside the transaction of a commit that settled count inputs.
  settled(count: number): void {
    this.#database
      .prepare(
        `UPDATE ${derivedStatus} SET "pending" = max("pending" - ?, 0) WHERE "dataset" = ?`,
      )
      .run(count, this.#dataset);
  }

  protected override async write(
    values: Readonly<Record<string, string | number | null>>,
  ): Promise<void> {
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
}
