# A file that several connections load shows one pass

A host can load several sources into one SQLite file, one connection for each source. For example, the Dia connector of Context Compiler loads the Chromium source and the Dia source into one import. The view `sync_status` has one row for each connection. `readPassStatus` read only one of these rows. Thus the status of the file could show `succeeded` while the pass of a different connection failed or still ran.

Now `readPassStatus` reads the row of each connection and shows them as one pass. This pass is only as good as its worst connection:

- It is `running` when one pass runs.
- Else it is `cancelled` when one pass stopped.
- Else it is `succeeded` when all passes succeeded, and `failed` when all passes failed.
- In all other cases it is `partial`.

The pass starts when the first pass started, and it completes when the last pass completed. Its error has the error of each pass that did not succeed, one error on each line, as `errors.Join` of Go does. Its failure type is `config` when one pass has a `config` failure, because the user must then do something. Else it is `system`. Its last success and its `current_as_of` are the earliest of the passes, because the file is only as current as its least current connection. When one pass has no value, the value is null.

The status of each stream does not change: `stream_status` already has one row for each stream of each connection.

## Considered Options

- **The host reads `sync_status` and combines the rows.** Each host must then have the same rules.
- **The status of the latest connection only.** The failure of a different connection is then hidden.
- **`readPassStatus` combines the rows, and the worst state wins.** This option was selected.

## Consequences

- A file with one connection shows the same pass as before.
- A host reads one pass for each file. It does not know the names of the connections.
