import type { CrawlClock } from './origin-records.ts';

/**
 * A clock whose waits take no real time, for a test of many requests. Each
 * wait moves `performance.now()` by its length and ends in the next turn of
 * the event loop, so the delays of the origins pass on their own while a
 * mocked server answers; a fake clock such as `@sinonjs/fake-timers` moves
 * only when the test ticks it. The wall time comes from `wall`, such as a
 * test's mocked `Date`.
 */
export class InstantClock implements CrawlClock {
  #now = 0;
  readonly #timers = new Map<object, NodeJS.Immediate>();

  readonly Date: { now(): number };

  readonly performance = { now: () => this.#now };

  constructor(wall: { now(): number }) {
    this.Date = wall;
  }

  setTimeout(callback: () => void, ms: number): object {
    this.#now += ms;
    const timer = {};
    this.#timers.set(
      timer,
      setImmediate(() => {
        this.#timers.delete(timer);
        callback();
      }),
    );
    return timer;
  }

  clearTimeout(timer: unknown): void {
    if (!(timer instanceof Object)) return;
    clearImmediate(this.#timers.get(timer));
    this.#timers.delete(timer);
  }
}
