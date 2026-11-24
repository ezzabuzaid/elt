# A dataset failure fails only its dataset, and a watch gives it beside its passes

The first derived dataset whose refresh failed stopped the whole watch. `DerivedRefreshes` kept the failure, started no more refreshes, and aborted every connection, and `Pipeline.watch` then rejected with the `DerivedDatasetError`. ADR 0003 gave this rule with no reason. Commit 710ce3fa already made one case wait in place of stopping, a computed dataset over a table that a person dropped, because a stop of every connection was the problem there too.

datahub's local warehouse is SQL Server 2025 in Docker. That server refuses the vector index of a computed dataset: error 343 when `PREVIEW_FEATURES` is off, and error 42217 when it is on, because the key is a `bigint` (elt-sqlserver ADR 0013). Thus datahub's watch stopped at its first pass on each local run, and no other dataset and no other connection got new data (datahub #5453). datahub will also host its writer in its web process (#5408). There, a watch that rejects stops the web server.

This is a missing bulkhead. A bulkhead keeps a failure inside one compartment, as the walls of a ship keep water in one part of the hull. dbt does this for models: when one model fails, dbt skips only the models that read it, and it runs the others. elt already does it for the change signals of a source (ADR 0020) and for the rule failures of a computed dataset (ADR 0004).

## Decision

A dataset failure fails only its dataset (Ezz, 2026-11-23):

- The dataset records `failed` and its error in `derived_status`. Each kind of each destination does this: `View`, and `ComputedDataset` also when it cannot read its inputs.
- The other datasets still refresh, in declared order. elt knows only the declared order (`earlier`), not which dataset reads which. Thus a dataset that reads the failed one reads what the failed one made last. A view that never appeared is read as a view that waits: a view after it that reads it waits too, as `refreshView` does for a view that waits, and a computed dataset finds no inputs in it.
- The connections and their passes go on. No sync history records a dataset failure (ADR 0004).
- The refresh after the next pass tries the failed dataset again. A commit refresh does not try it. This is the rule of a failed input of a computed dataset: "a failed input waits for the refresh after the passes". Thus a dataset that always fails is tried once for each pass, not at each commit of a long pass. A failed refresh also forgets which inputs the refreshes for the commits of the passes tried. Without this, the refresh after the passes would skip the inputs that the failed refresh took, for example the batch of a rule call that threw, and it would end with no failure although no output records them.
- A refresh that the stop of the watch or of the run ended is no failure, as before.

The host hears of the failure because `pipeline.watch` gives it. A watch gives a `WatchEvent`, which is one of two kinds:

```ts
type Pass<Target> = {
  readonly kind: 'pass';
  readonly connection: Connection<Target>;
  readonly outcomes: readonly CopyOutcome<Target>[];
};
type DatasetFailure = {
  readonly kind: 'refresh';
  readonly dataset: string; // the name of the derived dataset
  readonly error: unknown; // the dataset's own error, such as the store's
};
type WatchEvent<Target> = Pass<Target> | DatasetFailure;
```

A host narrows on `kind`, and logs a dataset failure where it logs a failed pass:

```ts
for await (const event of pipeline.watch({ signal })) {
  if (event.kind === 'refresh') {
    warn('A derived dataset failed', {
      dataset: event.dataset,
      error: event.error,
    });
    continue;
  }
  const { connection, outcomes } = event; // a pass
}
```

Spark gives the progress and the failures of a streaming query to a `StreamingQueryListener`, and Dagster writes each failed step to its event log beside the other events of the run. The watch is the event stream of elt, so a failure goes into it.

The rules of the event:

- **When.** The watch gives one `DatasetFailure` when a dataset starts to fail: once for each run of failures. While the dataset keeps failing, its retries give no more events. Once a refresh of it ends with no failure, a later failure gives an event again. The watch records the failure of a change signal once in the same way (ADR 0020). `derived_status` always shows the error of the last attempt.
- **Promptly.** A refresh runs in the background (ADR 0003), so a dataset can fail while no pass comes, for example while the watch waits for a change. Thus the watch merges the failures with the passes, as one more async iterable in the `interleave` of its connections. The watch gives a failure as soon as the refresh of that dataset failed, not at the next pass. Once every connection stopped, the watch stops its refreshes and its failures too, as before.
- **The error.** `error` is the dataset's own error, for example the error of SQL Server with its number. `dataset` names the dataset, so the event does not wrap the error in a `DerivedDatasetError`.
- **Only a pass asks for a refresh.** The watch asks for the refresh after a pass when it gives a pass, not when it gives a failure.

`Pipeline.run()` follows the same bulkhead. Each commit asks for a refresh in the background, and after the passes the run refreshes every dataset once more, also when a dataset failed before. That refresh tries each failed dataset again. Then the run rejects so that its caller learns of the failure, and the rejection keeps the contract that it had:

| What failed                                   | `run()` rejects with                                                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only copies                                   | A `PipelineError`, as before                                                                                                                       |
| One dataset, with or without copies           | Its `DerivedDatasetError`: `dataset` names it, and `cause` is its own error                                                                        |
| More than one dataset, with or without copies | A `DerivedDatasetsError`, an `AggregateError` whose `errors` holds the `DerivedDatasetError` of each, in declared order, with the first as `cause` |

A `PipelineError` means that the sync history recorded each failure that it holds. A host relies on this: Context Compiler's connector takes a `PipelineError` as an import that the history describes, and it keeps each other error as the failure of the connection. No sync history records a dataset failure (ADR 0004), so the dataset failure rejects the run as itself, and it comes before a `PipelineError`, as the dataset failure did before. The sync history still records each copy that failed. When the signal stops the run during its passes, the run still rejects with the reason of the signal.

These stay as they were:

- An error that the sync history could not record stops every connection, and the watch rejects with it. No reader would see that error otherwise.
- A connection whose change signals break the contract stops alone, and the watch then rejects with a `WatchError` (ADR 0020).

## Considered Options

- **A dataset failure stops the watch.** This was the rule. One dataset that its store refuses stops every connection, and in a web process it stops the server.
- **The dataset records its failure in `derived_status` only.** The watch goes on, but a host does not hear of the failure. A log that a person reads then shows no failure, and only a reader of `derived_status` sees it.
- **elt calls `process.emitWarning`.** A package then writes to the process of its host. elt reads no `process.env` and writes no `console` (AGENTS.md), and a host cannot tell which watch the warning came from.
- **The watch gives the failure as a second kind of event.** The host already reads the watch, and it narrows on `kind`. This option was selected (Ezz, 2026-11-23).

For the rejection of a run:

- **A `PipelineError` that also holds the dataset failures.** A caller has one type to catch. But a `PipelineError` then holds a failure that no sync history recorded, and a host that reads it as "the history recorded each failure" hides the dataset failure. The tests of Context Compiler's connector showed this with a first draft of this change.
- **The dataset failure as itself, one error or an aggregate.** The contract of `PipelineError` stays. This option was selected (Ezz, 2026-11-23).

## Consequences

- Each loop over `pipeline.watch` narrows on `kind`. A loop that reads `connection` or `outcomes` does not compile until it narrows.
- A run whose dataset failed in a refresh for a commit, and refreshed with no failure after the passes, resolves.
- A view that reads a view declared after it fails the refresh for the first commit, because the later view is not there yet. The refresh after the passes tries it again, and then the later view is there. Before, this failed the run. A watch gives that first failure as a `DatasetFailure`.
- A dataset that always fails is tried again after each pass, as an input that always fails is (ADR 0004).
- datahub's local run goes on when SQL Server refuses the vector index. The other datasets refresh, and `derived_status` shows the vector dataset `failed` with error 343.

Sources: datahub backlog #5453; ADRs 0001, 0003, 0004, 0017 and 0020; commit 710ce3fa.
