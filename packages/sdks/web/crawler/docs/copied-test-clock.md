# Test code copied between test files

Five test files run their crawls on a fake clock: `src/slowdown.test.ts` and `src/origins.test.ts` of this package, and `src/origins.test.ts`, `src/web-source.test.ts` and `src/link-discovery.test.ts` of `packages/sources/web/pages`. Each file keeps its own copy of the clock code.

The copies stay. A test clock is not a fake of a boundary that the package owns, so no package exports it (`AGENTS.md`, "Fake only what cannot run for real"; backlog #3978, closed). Make each fix in each copy, and name the files in the commit.

## Copied from `src/slowdown.test.ts` to `src/origins.test.ts`

- `clock(now)`: a `createClock(now)` of `@sinonjs/fake-timers` whose timers wait their length rounded up to whole milliseconds, as the timers of Node do. The two copies are the same.
- `settled()`: whether a promise settled in one turn of the event loop.
- The loop in `crawled()` that fires each pending timer at once. In `origins.test.ts`, `crawled()` also collects the pages and the failures of the crawl. In `slowdown.test.ts`, it returns the memento of the crawl.

## Copied from `src/origins.test.ts` to `src/origins.test.ts` of `packages/sources/web/pages`

- `clock(now)` and `settled()`: the code is the same.
- The loop in `crawled()` is `ran()`. It drives a promise of a pipeline run, not a crawl, so it collects nothing.

## Copied from `src/origins.test.ts` to `src/web-source.test.ts` of `packages/sources/web/pages`

- `clock(now)`, `settled()` and `ran()`: the code is the same.
- Only the test of the spacing of requests uses this clock. The other tests of the file use `globalThis`, or a clock of their own, because they assert no gap between requests.

## Copied from `src/origins.test.ts` to `src/link-discovery.test.ts` of `packages/sources/web/pages`

- `clock(now)`, `settled()` and `ran()`: the code is the same.
- Only the test of an interruption during archive pages uses this clock. The slow answers of its site are also timers on this clock, so `ran()` also ends those waits at once.
