# Test code copied between test files

Two test files run their crawls on a fake clock: `src/slowdown.test.ts` and `src/origins.test.ts`. Each file keeps its own copy of the clock code. The code is not shared yet.

The reason is the Rule of Three. A second place copies the code. A third place extracts it, and the three working copies give the boundary of the shared code. The third place is the next crawler test file that moves to this clock (backlog #3978). The shared code is then a class that the package exports under a `./test` subpath. Until then, make each fix in both copies, and name both files in the commit.

## Copied from `src/slowdown.test.ts` to `src/origins.test.ts`

- `clock(now)`: a `createClock(now)` of `@sinonjs/fake-timers` whose timers wait their length rounded up to whole milliseconds, as the timers of Node do. The two copies are the same.
- `settled()`: whether a promise settled in one turn of the event loop.
- The loop in `crawled()` that fires each pending timer at once. In `origins.test.ts`, `crawled()` also collects the pages and the failures of the crawl. In `slowdown.test.ts`, it returns the memento of the crawl.
