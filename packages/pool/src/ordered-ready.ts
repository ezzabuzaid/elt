import type { Startup } from './startup.ts';

// Starts every worker when the pool is constructed, one at a time: each
// creation waits until the previous one settles, as Kubernetes starts the
// pods of an OrderedReady StatefulSet.
export class OrderedReady implements Startup {
  readonly eager = true;
  #previous = Promise.resolve();

  turn(settled: Promise<void>): Promise<void> {
    const previous = this.#previous;
    this.#previous = settled;
    return previous;
  }
}
