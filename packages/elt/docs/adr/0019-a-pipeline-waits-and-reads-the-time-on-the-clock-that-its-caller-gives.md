# A pipeline waits and reads the time on the clock that its caller gives

A pipeline waits. A watch waits before it watches again after a `system` failure ([ADR 0016](./0016-a-watch-watches-again-after-its-watcher-fails-for-a-system-reason.md)), waits for a watcher to stop, and wakes a stream when the stream is due. Sources wait and read the time too: a source polls for changes, a Search Console quota resets at midnight in the Pacific time zone, the web crawler waits between two requests to one origin, and the web source saves its progress each second. A destination records the time of a load. When each of these reads `Date`, `performance` and the timers of the process, a test can only wait real time.

zukhruf's libraries take the clock as an input ([zukhruf ADR 0004](https://github.com/JanuaryLabs/zukhruf/blob/main/docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md)), and `island/no-ambient-time` of `@zukhruf/eslint` reports a direct read of the time in library code.

Thus `new Pipeline({ ..., clock })` takes a required clock: a `PipelineClock`, which is the `Clock` of `@zukhruf/async` with `Date`. The pipeline gives its clock on each call that it makes, so one pipeline runs on one clock, as a pool of `@zukhruf/pool` gives its clock to its eviction ([pool ADR 0008](https://github.com/JanuaryLabs/zukhruf/blob/main/packages/pool/docs/adr/0008-the-pool-measures-and-waits-on-the-clock-that-the-caller-gives.md)):

- `source.watch({ streams, signal, clock })`
- `source.read(catalog, states, { signal, clock })`, which gives the clock to `open(streams, signal, states, clock)`
- `destination.load({ clock })`
- `history.install(connections, at)`, `history.begin(connection, copies, at)`, and `finish(outcomes, upstream, at)` and `fail(error, failureType, at)` of the pass that `begin` returns, with the time of the event from the clock. `history.checked(connection, at, current)` also gets the time of the check.

An app gives `globalThis`. A test gives `createClock()` of `@sinonjs/fake-timers` and moves it with `await clock.tickAsync(ms)`.

## Considered Options

- **Tests replace the global timers** (`install()` of `@sinonjs/fake-timers`). No signature changes, and only the tests that wait change. But the fake does not reach `node:timers/promises`: in a probe, a `setTimeout(1000)` of that module stayed pending after `tickAsync(1000)`. The fake also changes the time of each library in the process, and a test that fakes the time cannot run at the same time as other tests.
- **Each source and each destination takes a clock in its constructor.** A pipeline and its sources can then run on different clocks.
- **The pipeline gives its clock on each call.** This option was selected.

## Consequences

- Each `new Pipeline` gives a clock, also in a test that does not wait: such a test gives `globalThis`.
- A source that reads the time reads it from the clock of the call. A source that reads the time in `extract` keeps the clock of `open` in its context. A source that does not read the time does not declare the parameter.
- A library of elt that waits or reads the time takes the clock from its caller. Only apps read `globalThis` directly, by giving it.
- A sync history does not read a clock and does not use the time of its database. The start and the end of a pass and the time of a check come from the clock of the pipeline. Thus `current_as_of`, which compares the start of a pass with a later check, compares two times of one clock.
