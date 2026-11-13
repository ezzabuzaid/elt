# A source gives its change signals, and a failed signal fails only its streams

Changed in part on 2026-11-13 (#4293): after a `system` failure, the first check that reads the gauge loads its streams again, also when the value did not change. Before, such a stream loaded only when a later check read a new value. The sync history shows the latest attempt of a stream, and the failure is a failed attempt, so the stream and its connector showed as failed until the next change. On a Mac with the lid closed, a check that was in flight when the computer slept timed out, because the timers of Node.js count the time of a sleep. Edge then showed as failed for eight hours, while each later check found its store unchanged. Prometheus sets the health of a target at each scrape, good or bad ([`Target.Report`](https://github.com/prometheus/prometheus/blob/main/scrape/target.go)); a pass is how this history sets it to good. A history record of a pass that read nothing was refused, because an attempt is a read. The cost is one pass of the streams of the gauge for each run of failures.

A watch keeps the streams of a connection current. At each check, the source looks at its upstream and tells the pipeline which streams changed. Until now, each source wrote this look itself, in `observe()`. Twenty sources made a change watcher of `@zukhruf/async` ([zukhruf async ADR 0008](https://github.com/JanuaryLabs/zukhruf/blob/main/packages/async/docs/adr/0008-a-change-watcher-reads-gauges.md)) over the gauges of their stores, read its outcomes, threw the first failed outcome, and gave back the streams of the gauges that changed. The same ten lines were in each of the twenty sources. Five other sources waited in their own way: EventKit checks (Calendar, Reminders), due times (web pages, the inspections of Search Console) and a fixed time (Instagram).

A throw from `observe()` stops the whole watch of the source. For example, a watch of Books starts, and Books has no themes store. The source throws `StoreUnavailableError`. Its failure type is `config`, so the pipeline stops the connection ([ADR 0016](./0016-a-watch-watches-again-after-its-watcher-fails-for-a-system-reason.md)). The library, the annotations and the asset data then also get no changes, and a new watch stops in the same way while the themes store is missing. A `system` failure restarts the watch, and each stream of the connection loads again. A test on 2026-11-06 showed the same result when one store becomes unreadable during a watch (#3897).

zukhruf async ADR 0008 makes a failure the outcome of one gauge, as Prometheus marks one failed target and reads the others. The sources threw it, so one store stopped each other store. Three workarounds came from this:

- `WhatsAppVersion` reads a store that it cannot open as the value `missing` (`MissingStore`), so that the watch does not stop.
- The Mail source gives `null` in place of the version of the Accounts store when it cannot open that store.
- The version handles of Books, Safari, Clock and WhatsApp, and the gauges of Chromium, keep a `store` field only so that the loop of the source can find the streams of a gauge (elt `4bc590bb`).

Also, `AppDatabaseVersion` opens its database when it is made. Thus a store that cannot be read stops the watch before its first check.

The loop mixed four jobs that have four owners:

| Job                                                                          | Owner                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| How to read one value of a store                                             | The SDK of the store, or `@zukhruf/async` (`Period`, `Group`) |
| Which streams a value tells about, and how often to read it                  | The source                                                    |
| Read the values at each check, and give the outcome of each stream           | elt                                                           |
| What an outcome means for a pass, for current as of and for the sync history | The pipeline                                                  |

## Decision

- A **change signal** is a gauge, the streams that it tells about, and the `interval` and `timeout` of its checks.
- A source declares its change signals for the selected streams: `changeSignals(streams, clock)`. It is a declaration, as `coverage(stream)` is: it does no I/O. The pipeline gives its clock, as it gives it on each call ([ADR 0019](./0019-a-pipeline-waits-and-reads-the-time-on-the-clock-that-its-caller-gives.md)): a gauge that waits or reads the time, such as the probe of Google Health that spaces its calls to the API, does it on that clock. Each gauge opens what it reads in its first read, not when it is made. Thus a store that cannot be read stops no other stream. Its gauge fails, or the gauge reads the store as a value: `AppDatabaseVersion` reads a store that is missing, or that the process cannot open, as `'unavailable'`. That value is a change, so the streams of the store run a pass, and their read fails with the `config` error that names what the user must fix.
- Each selected stream is in one change signal or more, and the change signals of one stream have one interval and one timeout. A change signal that names an unselected stream, a selected stream in no change signal, or two intervals for one stream breaks the contract, and the connection stops, as before.
- `Source` has no `watch` and no `observe`. The pipeline reads the change signals. It makes one change watcher for each interval and timeout, and it takes the outcome of each stream that a check covered:
  - **changed** when one of its gauges changed,
  - else **failed**, with the error, when one of its gauges failed,
  - else **unchanged**.
- The pipeline owns the gauges that `changeSignals` gives. When the watch stops, it disposes each gauge that is `Disposable` or `AsyncDisposable`, one time each. A gauge that stops a helper process can take a moment to stop: the watch waits for it, within the grace of a stopping watch, as it waited before for a source that stopped its watch.
- The pipeline decides what each outcome means:
  - A **changed** stream waits for a pass, as before.
  - An **unchanged** stream is current as of the check, as before.
  - A **failed** stream is not current as of the check. The sync history records the failure one time, when the change signal of the stream starts to fail, as a failed pass of that stream with the failure type of the error. The watch continues for the other streams.
  - After a `system` failure, the next check reads the gauge again, as Prometheus scrapes a failed target again at its next interval.
  - After a `config` failure, the pipeline reads that gauge no more in this watch, and its streams stay failed. The failure names what the user must fix, and a new watch reads the gauge again. This is the rule of [ADR 0016](./0016-a-watch-watches-again-after-its-watcher-fails-for-a-system-reason.md) for a `config` failure, for the streams of one gauge in place of the whole connection. A gauge that logs in, such as one of SQL Server, thus does not try a refused login again at each check.
- The first check reads each gauge at once, so each stream is changed or failed. A stream that failed loads when a later check reads its gauge.
- The first pass waits for the first check of each interval, also when that check fails or times out. Thus the first pass reads all changed streams as one task group ([ADR 0018](./0018-the-streams-of-a-read-are-one-task-group.md)), and the first value of each gauge is the base for its next checks. A Kubernetes informer also lists all objects one time before it watches. After the first pass, each change starts a pass.

The author of a source writes only what changes for which streams:

```ts
// Books: one change signal for each store, with the streams that read it
changeSignals(streams: readonly Stream[], clock: PipelineClock) {
  return Map.groupBy(streams, (stream) => readerOf(stream).store)
    .entries()
    .map(([store, watched]) => ({
      gauge: this.#books.version(store),
      streams: watched,
      // The reads are local: a check that takes the whole interval is stuck.
      interval: 1000,
      timeout: 1000,
    }));
}
```

A host does not change: it calls `pipeline.watch()`. When the themes store of Books is missing, the watch continues, the sync history has a failed pass for `themes` with the type `config`, and the other streams of Books load each change.

## Precedents

- **Prometheus** runs one scrape loop for each target, and a failed scrape stays in its own loop: the `up` gauge of the target is 0, the target keeps its last error, and the next scrape is the next interval ([scrape.go](https://github.com/prometheus/prometheus/blob/dd7aa6b0f19f4e952a55cbebd6e15458fe0ad9c6/scrape/scrape.go#L580-L585), [`up`](https://github.com/prometheus/prometheus/blob/dd7aa6b0f19f4e952a55cbebd6e15458fe0ad9c6/scrape/scrape.go#L2307-L2311)). A scrape configuration declares its targets and its own interval, and the scrape manager runs the loops.
- **controller-runtime** puts back only the key whose reconcile failed, and the other keys continue ([reconcileHandler](https://github.com/kubernetes-sigs/controller-runtime/blob/4fd0ea28e5d664a4b417d917be6da1266d8d3ca7/pkg/internal/controller/controller.go#L464-L518)). A controller declares what it watches, and the manager runs the watches.
- **The Airbyte CDK** gives a failed stream the status `INCOMPLETE` and continues with the next stream ([abstract_source.py](https://github.com/airbytehq/airbyte-python-cdk/blob/a0d630a683a98a39a8ec3ed75230fd1b750447cb/airbyte_cdk/sources/abstract_source.py#L185-L219)).
- [ADR 0010](./0010-a-watch-keeps-watching-after-an-incomplete-pass.md) already keeps a watch after a copy fails. This decision does the same for a change signal.

## Considered Options

- **Each source throws the first failed outcome.** One store that cannot be read stops each other store of the source.
- **A template class over `observe()` that yields the changed and the failed streams.** Each source keeps its own loop under the loop of the pipeline, and the three workarounds stay.
- **`Source.watch()` runs the change watchers, and the pipeline reads it.** A test of a source can then read the watch without a pipeline. But this puts the loop into `Source` only for the tests, and a test of a watch through a real pipeline is the style of elt.
- **One interval for each source.** Search Console reads Google each six hours and wakes an inspection when its URL is due. One interval makes the inspections late, or reads Google each minute.
- **A back-off for a failed change signal, as controller-runtime has.** A local read costs little, and a read of the network has a long interval. The next check is the next try, as in Prometheus.
- **A source declares its change signals, and the pipeline reads them.** This option was selected.

## Consequences

- `observe()` and `watch()` go from `Source`. Each source declares `changeSignals()`, and the twenty copies of the loop go.
- A test of a watch runs a real pipeline, as the other tests of a source do.
- A due time is a gauge whose value is the last due time that the stream reached. A due stream wakes at the first check after its due time, at most one interval late. A probe on 2026-11-06 ran the five watch tests of the web source with such a gauge, and they passed. A gauge that never becomes due failed three of them.
- The EventKit SDK gives a gauge whose value counts the changes that its helper reports. The gauge starts the helper in its first read and stops it when the pipeline disposes it. Instagram watches a `Period` of `@zukhruf/async`.
- `MissingStore` of WhatsApp, the `null` of Mail and the `store` fields go. `AppDatabaseVersion` opens its database in its first read.
- `DataVersion` of `@zukhruf/sqlite-data-version` still opens its database when it is made. A source that declares it in `changeSignals` stops its connection when the file cannot be opened, as before this decision. Ezz accepted this on 2026-11-07 in place of a lazy `DataVersion`; `AppDatabaseVersion` wraps it for the stores of Mac apps.
- A `config` failure of a change signal no longer stops the connection: it stops only the streams of its gauge. A broken contract still stops the connection.
- The watch of a source no longer fails as a whole: a failure is the outcome of one gauge. Thus the restart of [ADR 0016](./0016-a-watch-watches-again-after-its-watcher-fails-for-a-system-reason.md) after a `system` failure of the watcher has no case left, and it goes. Its case, one dropped connection to one of three Azure SQL databases, is now a failed gauge that the next check reads again.
- About eighty test sources in the tests of elt, of its destinations and of `embedding` declare change signals in place of `observe()`.
- The test "a Books watch fails before its first batch when a watched database is missing" changes: the themes stream fails, and the other streams load.
