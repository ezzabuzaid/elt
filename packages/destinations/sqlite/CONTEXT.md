# elt-sqlite

A host wants the data that elt copies in one SQLite file, which a reader can query with `sqlite3 -readonly`. The SQLite destination keeps the stream of each copy as a raw table, a reader view over it, and a catalog that describes each table, view and column. It also has the two kinds of derived dataset: `View` and `ComputedDataset`. The words that all of elt uses, for example pass, refresh, rule and key, are in the glossary of [elt](../../elt/CONTEXT.md).

## Language

**SQLite file**:
The file that one `SQLiteDestination` writes.
_Avoid_: Database (a database can be many files), store, import (Context Compiler keeps one SQLite file for each import)

**Raw table**:
The table that a copy loads, for example `raw_documents`.
_Avoid_: Staging table, source table

**Reader view**:
The view that a copy makes over its raw table with `withReaderView`, for example `documents`. Readers query it.
_Avoid_: View (a `View` is a derived dataset)

**Catalog**:
The view `catalog` that lists each table, view and column of the SQLite file, with its description.
_Avoid_: Schema, metadata

**View**:
A derived dataset that SQLite computes on each read, from its SQL. It names no inputs: its SQL reads them.
_Avoid_: Reader view, materialized view

**Wait**:
A view waits while its SQL reads a raw table or a reader view that a copy of the pipeline has not made yet. The refresh then makes no view, and it does not fail.
_Avoid_: Skip (a view that waits appears at a later refresh), pending

**Computed dataset**:
A derived dataset that keeps one output row for each key in the table `raw_<name>`. Readers query it through the view `<name>`.
_Avoid_: Cache, index, materialized view

**Output row**:
The row that a computed dataset keeps for one key: the key, the input hash, the rule identity, the status, the error, and the columns of the rule.
_Avoid_: Result, record

**Status**:
`computed` when the rule made a value, `empty` when it found nothing to keep, and `failed` when it failed on the input.
_Avoid_: State (a checkpoint holds state), outcome

**Input hash**:
The SHA-256 of the input of an output row. A changed input hash makes the output row again.
_Avoid_: Checksum, fingerprint, sha256 (the ref of a stored file is also named by a SHA-256)

**Declaration**:
The `CREATE TABLE` statement of the raw table of a computed dataset. When the stored table is different, a refresh makes the table again.
_Avoid_: Schema version, migration

**Stage**:
The `TEMP` table where one stream keeps its operations until its next commit. Only its connection sees it.
_Avoid_: Buffer, batch, staging table (a stage is not in the SQLite file)

**Hidden table**:
The table `_elt_next_<hash>` that a reload commits into. It takes the place of the raw table when the stream ends with no failure.
_Avoid_: Shadow table, temp table

**Checkpoint file**:
The SQLite file of a `SQLiteCheckpointStore`. It is not a SQLite file of a destination.
_Avoid_: State database

**Sole writer**:
A `SQLiteSyncHistory` whose host knows that no other process runs a pass of its connections. Its install fails the passes that it finds unfinished.
_Avoid_: Leader (the leader of a flight is one host that can be a sole writer), owner
