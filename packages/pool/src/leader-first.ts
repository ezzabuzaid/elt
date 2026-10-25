import type { Startup } from './startup.ts';

// Starts every worker when the pool is constructed. The first starts alone and
// the others start together once it settles, as when the first worker fills a
// cache that the others then read instead of rebuilding it. A replacement
// after a crash starts at once, since the first creation has settled.
export class LeaderFirst implements Startup {
  readonly eager = true;
  #leader: Promise<void> | undefined;

  turn(settled: Promise<void>): Promise<void> {
    if (this.#leader !== undefined) return this.#leader;
    this.#leader = settled;
    return Promise.resolve();
  }
}
