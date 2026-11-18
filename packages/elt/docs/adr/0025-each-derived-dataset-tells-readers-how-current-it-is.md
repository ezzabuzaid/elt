# Each derived dataset tells readers how current it is

ADR 0017 asks for a refresh at each commit, and leaves the completeness of derived data to the reader. A probe on 2026-11-09 (#4201) showed what a reader then saw: when `sync_status` said `succeeded`, a computed dataset of vectors held 112 of 600 rows, and a view gave `no such table` for 1.13 seconds longer. With the model down, each of the 600 rows failed, and `sync_status` still said `succeeded`. Before the first attempt, `sync_status` is empty. Datahub's MCP reads the warehouse with no other source, so it must say "still loading" or "as of" (backlog #4207).

The leading systems give a reader one row for each derived object:

- Snowflake keeps the `STATE` of each refresh of a dynamic table, and its `DATA_TIMESTAMP`: the data that arrived in its inputs before that time is in it.
- Materialize keeps whether each object is hydrated, and its write frontier, which a reader compares with the frontiers of its inputs.
- pgai keeps `pending_items` for each vectorizer: the rows whose embeddings are still to make.
- dbt keeps the status of each node of a run (`run_results`), and Dagster keeps whether an asset is missing, stale or fresh.

Thus each view and computed dataset keeps one row of `derived_status`, beside its data, and each sync history publishes it with the same description (`syncHistoryRelations`). A refresh writes `waiting` while an input is not made yet, `refreshing` while it runs, and then `current`, with `as_of`, when it began to read, or `failed`, with the error. A computed dataset also writes how many inputs it read and how many it has still to compute; each commit of the refresh lowers that count in its own transaction. A dataset is caught up when it is `current`, it has nothing pending, and its `as_of` is at or after the start of the last pass of the connections that it reads.

## Considered Options

- **A reader judges completeness.** A reader cannot count the inputs that a dataset has still to compute.
- **The pipeline records each refresh through the sync history, as it records a pass.** The pipeline sees when a refresh starts and ends, but not the inputs that remain, which change at each commit of the refresh.
- **Each dataset writes its own status, which the sync history publishes.** The dataset knows its inputs and lowers its pending count in the transaction of each commit. This option was selected.

## Consequences

- `computed`, `empty` and `failed` count the output rows when a refresh begins and ends; `pending` is the count that moves during a refresh. A reader counts the rows of the dataset for the rows that landed since.
- A refresh that a stopped process left stays `refreshing` until the next refresh, as a pass that a stopped process left stays `running`.
- The status keeps no row versions, so a reading as of a position fails it, as it fails the other relations of the sync history.

Sources: #4207, #4201.
