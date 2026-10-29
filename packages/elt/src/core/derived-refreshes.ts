import type { Connection } from './connection.ts';
import type { DerivedDataset } from './derived-dataset.ts';
import type { Target as DestinationTarget } from './target.ts';

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
  #running: Promise<void> | null = null;
  #again = false;
  #failure: { readonly error: unknown } | undefined;

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
    return this.#failure;
  }

  request(): void {
    if (this.#datasets.length === 0) return;
    if (this.#running !== null) {
      this.#again = true;
      return;
    }
    this.#running = (async () => {
      do {
        this.#again = false;
        for (const [index, dataset] of this.#datasets.entries())
          await dataset.refresh({
            connections: this.#connections,
            earlier: this.#datasets.slice(0, index),
            signal: this.#signal,
          });
      } while (this.#again && !this.#signal.aborted);
    })()
      .catch((error: unknown) => {
        if (this.#signal.aborted) return;
        this.#failure = { error };
        this.#stop(error);
      })
      .finally(() => {
        this.#running = null;
      });
  }

  async settled(): Promise<void> {
    await this.#running;
  }
}
