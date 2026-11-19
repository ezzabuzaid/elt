import type { PipelineClock } from './clock.ts';

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
// last refresh that ended, until it ends too. Each destination writes the
// values into its own derived_status (a Template Method).
export abstract class DerivedStatus {
  readonly #clock: PipelineClock;
  // When this refresh began to read, which its end gives as as_of.
  readonly #since: string;

  constructor(clock: PipelineClock) {
    this.#clock = clock;
    this.#since = this.#now();
  }

  waiting(): Promise<void> {
    return this.write({ state: 'waiting', refreshing_since: null });
  }

  refreshing(counts: DerivedCounts): Promise<void> {
    return this.write({
      state: 'refreshing',
      refreshing_since: this.#since,
      ...counts,
    });
  }

  // A view has no counts.
  current(counts?: DerivedCounts): Promise<void> {
    return this.write({
      state: 'current',
      as_of: this.#since,
      refreshed_at: this.#now(),
      refreshing_since: null,
      error: null,
      ...counts,
    });
  }

  failed(error: string): Promise<void> {
    return this.write({ state: 'failed', refreshing_since: null, error });
  }

  // Writes the row of the dataset with these columns, keeping the others.
  protected abstract write(
    values: Readonly<Record<string, string | number | null>>,
  ): Promise<void>;

  #now(): string {
    return new Date(this.#clock.Date.now()).toISOString();
  }
}
