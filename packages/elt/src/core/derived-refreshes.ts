import { Latch } from '@zukhruf/async';

import type { Connection } from './connection.ts';
import type { DerivedDataset } from './derived-dataset.ts';
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

// A refresh runs and a pass committed while it ran, so one more follows.
class Queued {
  readonly done: Latch;
  constructor(done: Latch) {
    this.done = done;
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

// A watch's refreshes of its derived datasets, in the background: one
// refresh at a time, and a pass that commits while one runs asks for one
// more, so no pass waits on them, as a build watcher keeps one rebuild queued.
// The first failure stops the watch; a refresh the watch's own stop ended is
// no failure.
export class DerivedRefreshes<Target extends DestinationTarget> {
  readonly #datasets: readonly DerivedDataset<Target>[];
  readonly #connections: readonly Connection<Target>[];
  readonly #signal: AbortSignal;
  readonly #stop: (error: unknown) => void;
  #state: Idle | Running | Queued = new Idle();
  #health: Healthy | Failed = new Healthy();

  constructor(
    datasets: readonly DerivedDataset<Target>[],
    connections: readonly Connection<Target>[],
    signal: AbortSignal,
    stop: (error: unknown) => void,
  ) {
    this.#datasets = datasets;
    this.#connections = connections;
    this.#signal = signal;
    this.#stop = stop;
  }

  get failure(): { readonly error: unknown } | undefined {
    return this.#health instanceof Failed ? this.#health : undefined;
  }

  request(): void {
    if (this.#datasets.length === 0) return;
    if (this.#state instanceof Running) {
      this.#state = new Queued(this.#state.done);
      return;
    }
    if (this.#state instanceof Queued) return;
    const done = new Latch();
    this.#state = new Running(done);
    void this.#run(done);
  }

  async settled(): Promise<void> {
    if (this.#state instanceof Idle) return;
    await this.#state.done.wait();
  }

  // Refreshes every dataset in order, once more while a pass asked for it.
  async #run(done: Latch): Promise<void> {
    try {
      for (;;) {
        for (const [index, dataset] of this.#datasets.entries())
          await dataset.refresh({
            connections: this.#connections,
            earlier: this.#datasets.slice(0, index),
            signal: this.#signal,
          });
        if (!(this.#state instanceof Queued) || this.#signal.aborted) break;
        this.#state = new Running(done);
      }
    } catch (error) {
      if (!this.#signal.aborted) {
        this.#health = new Failed(error);
        this.#stop(error);
      }
    } finally {
      this.#state = new Idle();
      done.open();
    }
  }
}
