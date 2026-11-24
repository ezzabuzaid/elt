# A deletion older than the stored row deletes nothing

A `DELETE` held only the key of the row. Each deduplicating writer deleted the stored row of that key, with no guard. A `cursor_newer` copy guards each record: a record replaces the stored row only when its cursor is greater than the cursor of the row. A deletion had no such guard. In the probe of 2026-11-24 (elt #5402, P7b), a deletion at version 3 deleted a stored row at version 5. A replay of old changes, or an upstream that sends its changes out of order, thus deleted rows that are newer than the deletion.

Inside one commit, the stage applied a different rule too. It kept only the records after the last `DELETE` of a key. Thus a record at version 5 and then a deletion at version 3 in one commit also deleted the row.

## Decision

Under `cursor_newer`, a deletion carries the value of the cursor field at which the upstream deleted the row, and competes with the records of its key by that cursor (Ezz, 2026-11-24, "Go with all four", elt #5402, condition 2).

```ts
// replace: the last message of a key wins.
{ type: 'DELETE', stream: 'notes', key: { id: 'n1' } }
// cursor_newer: the deletion's value of the cursor field.
{ type: 'DELETE', stream: 'notes', key: { id: 'n1' }, cursor: 7 }
```

- **Two shapes, one per policy.** `DeleteMessage` is `UnversionedDelete | VersionedDelete`, and the `DELETE` of `WriteOperation` (`DeleteOperation`) has the same two shapes. The type cannot select the shape, because the copy selects its dedup policy after the source is written, and one `extract` serves each copy. Core thus checks the shape at run time, at each `DELETE`. A `cursor_newer` copy refuses a deletion with no `cursor`, and a `cursor` that is not a valid value of its cursor field (the error of the value check is the `cause`). Every other copy refuses a deletion with a `cursor`, because no rule of that copy compares it. Each error is a `TypeError` that names the stream.
- **One rule in the stage.** Of the records and deletions of a key in one commit, the one with the greatest cursor wins. On a tie, the first one that the source emits wins. This is the rule that the stage already applied to records under `cursor_newer`.
- **One rule against the stored row.** A deletion that wins removes the stored row only when its cursor is greater than the cursor of the row. On a tie, the row stays, as it stays for a record with the same cursor. Each writer compares the cursors with the expression that its upsert uses (SQLite `COLLATE BINARY`, SQL Server `CONVERT(varchar(max), … COLLATE Latin1_General_100_BIN2_UTF8)`, Postgres `COLLATE "C"`). The history keeps a stored row only when a deletion removes it.
- **`replace` does not change.** Records and deletions apply in the order that the source emits them.
- **The count does not change.** `deleted` counts each accepted deletion, also one that loses to a newer row, as `count` counts a record that `cursor_newer` discards.

## Precedents

- **dlt** `merge` with a `hard_delete` column and a `dedup_sort` column (dlt-hub/dlt@fb7c116d `docs/website/docs/general-usage/merge-loading.md`, "Example: with primary key and "dedup_sort" hint", lines 214-235) ranks the deletions of a load with its records by the sort column: "This will insert nothing, because the "latest" record is a delete." On identical values, "the first occurrence encountered is kept" (lines 144-147). dlt then deletes the stored record with no guard.
- **Cassandra** reconciles a tombstone and a write of a cell by their timestamps, so an older tombstone does not remove a newer value. It keeps each tombstone for `gc_grace_seconds`, so that a replica that missed the deletion does not bring the value back.

## Considered Options

- **(i) Core gives `DELETE` a cursor, and each deduplicating writer guards it as it guards an upsert.** It is correct inside one commit and across commits. This option was selected.
- **(ii) The source drops a deletion at or below the version that it saved.** It covers a replay, but not a newer record and an older deletion in one pass, and each source would write it again.
- **(iii) No cursor on a deletion: the last message wins**, as the sources of elt did. A replay or an out-of-order change then deletes a newer row with no error.

## Consequences

- The sources of elt that delete all declare `sourceDefinedCursor`, so their copies use `replace` and their deletions do not change. The first source that sends a deletion with a cursor is the `changes` kind of `IterableSource` (#5402, D5).
- The rule "records and deletions apply in the order that the source emits them" holds only for `replace`.
- A SQL Server test that claimed that a deletion and then an older record of its key replace the stored row "whatever its cursor" now claims the opposite: a deletion newer than the stored row wins over the older record in the stage, so no row stays.
- **Limit: no writer keeps a deletion after its commit.** A record that is older than a deletion of an earlier commit thus loads again, for example in a replay that starts after the commit of the deletion. Cassandra keeps its tombstones for this reason. elt #5572 records it.
- `DeduplicationColumns.guard` and the guard of each writer are optional, and a deletion carries a cursor exactly when the guard exists. Two writer classes, one for each policy, would let the type join the two facts. elt #5573 records it.
