# Test code copied between test files

Three test files run their crawls on a fake clock: `src/slowdown.test.ts` and `src/origins.test.ts` of this package, and `src/origins.test.ts` of `packages/sources/web/pages`. Each file keeps its own copy of the clock code.

The copies stay. A test clock is not a fake of a boundary that the package owns, so no package exports it (`AGENTS.md`, "Fake only what cannot run for real"; backlog #3978, closed). Make each fix in each copy, and name the files in the commit.

## Copied from `src/slowdown.test.ts` to `src/origins.test.ts`

- `clock(now)`: a `createClock(now)` of `@sinonjs/fake-timers` whose timers wait their length rounded up to whole milliseconds, as the timers of Node do. The two copies are the same.
- `settled()`: whether a promise settled in one turn of the event loop.
- The loop in `crawled()` that fires each pending timer at once. In `origins.test.ts`, `crawled()` also collects the pages and the failures of the crawl. In `slowdown.test.ts`, it returns the memento of the crawl.

## Copied from `src/origins.test.ts` to `src/origins.test.ts` of `packages/sources/web/pages`

- `clock(now)` and `settled()`: the code is the same.
- The loop in `crawled()` is `ran()`. It drives a promise of a pipeline run, not a crawl, so it collects nothing.
