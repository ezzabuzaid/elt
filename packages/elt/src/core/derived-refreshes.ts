import { Latch } from '@zukhruf/async';

import type { Connection } from './connection.ts';
import {
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

// No refresh failed yet.
class Healthy {}

// The first refresh failure that the watch's own stop did not cause.
class Failed {
  readonly error: unknown;
  constructor(error: unknown) {
    this.error = error;
  }
}

// A pipeline's refreshes of its derived datasets. In the background, one
// refresh runs at a time, and a copy that commits while one runs asks for one
// more, so no pass waits on them, as a build watcher keeps one rebuild queued
// and Spark's default trigger starts the next micro-batch once the last one
// ended. The first background failure is told to stop and starts no more
// background refreshes; a refresh that signal's abort ended is no failure.
export class DerivedRefreshes<Target extends DestinationTarget> {
  readonly #datasets: readonly DerivedDataset<Target>[];
  readonly #connections: readonly Connection<Target>[];
  readonly #signal: AbortSignal | undefined;
  readonly #stop: () => void;
  #state: Idle | Running | Queued = new Idle();
  // Each dataset's keys that commit refreshes tried since the last pass
  // refresh; the memory of the passes that run, which ends with them.
  readonly #tried = new Map<DerivedDataset<Target>, Set<string>>();
  #health: Healthy | Failed = new Healthy();

  constructor(
    datasets: readonly DerivedDataset<Target>[],
    connections: readonly Connection<Target>[],
    signal: AbortSignal | undefined,
    stop: () => void,
  ) {
    this.#datasets = datasets;
    this.#connections = connections;
    this.#signal = signal;
    this.#stop = stop;
  }

  get failure(): { readonly error: unknown } | undefined {
    return this.#health instanceof Failed ? this.#health : undefined;
  }

  request(kind: Kind): void {
    if (this.#datasets.length === 0 || this.#health instanceof Failed) return;
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
  // the passes that ended, and rejects with its failure, as the end of a run.
  async refresh(): Promise<void> {
    await this.settled();
    await this.#refresh('pass');
  }

  // Every dataset in declared order, each after the ones it can read.
  async #refresh(kind: Kind): Promise<void> {
    for (const [index, dataset] of this.#datasets.entries()) {
      const tried = this.#tried.get(dataset) ?? new Set<string>();
      this.#tried.set(dataset, tried);
      try {
        await dataset.refresh({
          connections: this.#connections,
          earlier: this.#datasets.slice(0, index),
          signal: this.#signal,
          trigger: { kind, tried },
        });
      } catch (error) {
        // A stop is not the dataset's failure.
        if (this.#signal?.aborted === true) throw error;
        throw new DerivedDatasetError(dataset.name, error);
      }
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
    } catch (error) {
      if (this.#signal?.aborted !== true) {
        this.#health = new Failed(error);
        this.#stop();
      }
    } finally {
      this.#state = new Idle();
      done.open();
    }
  }
}
