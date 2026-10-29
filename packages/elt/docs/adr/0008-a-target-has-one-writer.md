# A target has one writer

Before, a writer recorded its mode, key and partitions as a claim, so that several writers could share a target. Those fields only predicted which rows a writer could delete. Airbyte keeps one owner for each table and permits no other.

Thus the owner of a target is its writer: the `id` of the copy, or the source and the stream for a copy with no `id`. Each destination keeps the writer of each target in `_elt_writers`. A different writer fails with `TargetOwnedError` before it extracts. Several properties share tables through one partitioned source, which is one writer.

## Considered Options

- **Several writers share a target, with claims of mode, key and partitions.** An overwrite or a snapshot delete of one writer can remove the rows of the other.
- **One writer for each target, as in Airbyte.** This option was selected.

## Consequences

- To change the owner, clear the target with the copy that owns it.
- A live check on 2026-09-25 refused a second writer of `sitemaps` before it extracted anything.
- The pipeline does not compare the targets of its copies before a run. Each destination refuses a second writer in its `_elt_writers` check (elt 05075913).

Sources: elt 4bd24a37, 05075913.
