import { Cond, Latch } from '@zukhruf/async';

import type { PipelineClock } from './clock.ts';
import type { Connection } from './connection.ts';
import {
  type DatasetFailure,
  type DerivedDataset,
  DerivedDatasetError,
  type RefreshTrigger,
} from './derived-dataset.ts';
import type { Target as DestinationTarget } from './target.ts';

// No refresh runs.
class Idle {}

// A refresh runs; done opens once it ended.
class Running {
  readonly done: Latch;
  constructor(done: Latch) {
    this.done = done;
  }
}

type Kind = RefreshTrigger['kind'];

// A refresh runs and a copy asked for one more while it ran: one follows, of
// the strongest kind asked, since a pass refresh does what a commit refresh
// does and more.
class Queued {
  readonly done: Latch;
  readonly kind: Kind;
  constructor(done: Latch, kind: Kind) {
    this.done = done;
    this.kind = kind;
  }
}

// A pipeline's refreshes of its derived datasets. In the background, one
// refresh runs at a time, and a copy that commits while one runs asks for one
// more, so no pass waits on them, as a build watcher keeps one rebuild queued
// and Spark's default trigger starts the next micro-batch once the last one
// ended. A dataset failure fails only its dataset, a bulkhead as dbt keeps
// one when it skips only the models that read a failed one: the other
// datasets still refresh (ADR 0031). A refresh that signal's abort ended is
// no failure.
export class DerivedRefreshes<Target extends DestinationTarget> {
  readonly #datasets: readonly DerivedDataset<Target>[];
  readonly #connections: readonly Connection<Target>[];
  readonly #clock: PipelineClock;
  readonly #signal: AbortSignal | undefined;
  #state: Idle | Running | Queued = new Idle();
  // Each dataset's keys that commit refreshes tried since the last pass
  // refresh; the memory of the passes that run, which ends with them.
  readonly #tried = new Map<DerivedDataset<Target>, Set<string>>();
  // The error of each dataset whose last refresh failed.
  readonly #failing = new Map<DerivedDataset<Target>, unknown>();
  // Each dataset that started to fail, until failures() gives it: one for
  // each run of failures, as the watch records a failed change signal once.
  readonly #started: DatasetFailure[] = [];
  readonly #failed = new Cond();

  constructor(
    datasets: readonly DerivedDataset<Target>[],
    connections: readonly Connection<Target>[],
    clock: PipelineClock,
    signal: AbortSignal | undefined,
  ) {
    this.#datasets = datasets;
    this.#connections = connections;
    this.#clock = clock;
    this.#signal = signal;
  }

  // The datasets whose last refresh failed, in declared order.
  get failing(): readonly DerivedDatasetError[] {
    return this.#datasets.flatMap((dataset) =>
      this.#failing.has(dataset)
        ? [new DerivedDatasetError(dataset.name, this.#failing.get(dataset))]
        : [],
    );
  }

  request(kind: Kind): void {
    if (this.#datasets.length === 0) return;
    if (this.#state instanceof Idle) {
      const done = new Latch();
      this.#state = new Running(done);
      void this.#run(done, kind);
      return;
    }
    this.#state = new Queued(
      this.#state.done,
      this.#state instanceof Queued && this.#state.kind === 'pass'
        ? 'pass'
        : kind,
    );
  }

  async settled(): Promise<void> {
    if (this.#state instanceof Idle) return;
    await this.#state.done.wait();
  }

  // Once the background refresh ended, refreshes every dataset once more for
  // the passes that ended, as the end of a run.
  async refresh(): Promise<void> {
    await this.settled();
    await this.#refresh('pass');
  }

  // Each dataset that started to fail, as its refresh ended, until signal
  // aborts.
  async *failures(signal: AbortSignal): AsyncGenerator<DatasetFailure> {
    while (!signal.aborted) {
      const failure = this.#started.shift();
      if (failure !== undefined) {
        yield failure;
        continue;
      }
      await this.#failed.wait({ signal }).catch((error: unknown) => {
        if (error !== signal.reason) throw error;
      });
    }
  }

  // Every dataset in declared order, each after the ones it can read.
  async #refresh(kind: Kind): Promise<void> {
    for (const [index, dataset] of this.#datasets.entries()) {
      // A failed dataset waits for the refresh after the passes, as a failed
      // input does, so a dataset that always fails is tried once a pass.
      if (kind === 'commit' && this.#failing.has(dataset)) continue;
      const tried = this.#tried.get(dataset) ?? new Set<string>();
      this.#tried.set(dataset, tried);
      try {
        await dataset.refresh({
          connections: this.#connections,
          clock: this.#clock,
          earlier: this.#datasets.slice(0, index),
          signal: this.#signal,
          trigger: { kind, tried },
        });
      } catch (error) {
        // A stop is not the dataset's failure.
        if (this.#signal?.aborted === true) return;
        if (!this.#failing.has(dataset)) {
          this.#started.push({ kind: 'refresh', dataset: dataset.name, error });
          this.#failed.broadcast();
        }
        this.#failing.set(dataset, error);
        // The refresh that tries it again tries again the inputs that the
        // failed refresh took, which no output records.
        this.#tried.delete(dataset);
        continue;
      }
      if (this.#signal?.aborted !== true) this.#failing.delete(dataset);
    }
    // The passes it follows ended, and their memory with them.
    if (kind === 'pass') this.#tried.clear();
  }

  // Refreshes once, and once more while a copy asked for it.
  async #run(done: Latch, first: Kind): Promise<void> {
    try {
      for (let kind = first; ;) {
        await this.#refresh(kind);
        if (!(this.#state instanceof Queued) || this.#signal?.aborted) break;
        kind = this.#state.kind;
        this.#state = new Running(done);
      }
    } finally {
      this.#state = new Idle();
      done.open();
    }
  }
}
