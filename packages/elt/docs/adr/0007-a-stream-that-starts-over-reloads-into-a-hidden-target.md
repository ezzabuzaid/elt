# A stream that starts over reloads into a hidden target

A SQL Server table can be too large to reload in one commit, and its change history can expire. Before, a `RESET` of the full stream, a restart for a new schema, or a stale table replaced the rows at the first commit. Thus readers saw a part of the table while the reload ran, and a source could send no `STATE` until the reload was complete.

Thus a reload goes into a hidden target. A reload opens when the load prepares the stream (a stored target that does not fit, or a reload that the last run left open), or when a `RESET` of the full stream comes. Its commits, also its checkpoints, go to the hidden target. `complete()` puts that target in the place of the target after the stream ends with no failure. `reloadMode()` is the one decision table of each destination.

The engine saves each checkpoint as `{ state, reloading }`. Thus a reload that fails resumes from its last checkpoint. A hidden target that no checkpoint continues is dropped. A new `RESET` or a clear discards it.

## Considered Options

- **Replace the rows at the first commit.** Readers see a part of the table during the reload.
- **Load into a hidden target and swap it in when the stream ends.** This option was selected.

## Consequences

- Postgres makes the hidden table `_elt_next_<hash>` at the first commit of the reload. It swaps it in at `complete()`, with a lock timeout of 3 seconds. A swap that times out fails the copy, and the next run continues the reload.
- SQLite makes the same hidden table and renames it in at `complete()`, with its reader view and its file triggers. File chunks that rows of either table refer to stay while a reload is open.
- A `RESET` of a partition still replaces only that partition at the next commit.

Sources: elt 312d8a29, c77d75db.
