# elt-sqlite

A host wants the data that elt copies in one SQLite file, which a reader can query with `sqlite3 -readonly`. The SQLite destination keeps the stream of each copy as a raw table, a reader view over it, and a catalog that describes each table, view and column. It also has the two kinds of derived dataset: `View` and `ComputedDataset`. The words that all of elt uses, for example pass, refresh, rule and key, are in the glossary of [elt](../../elt/CONTEXT.md).

## Language

**SQLite file**:
The file that one `SQLiteDestination` writes.
_Avoid_: Database (a database can be many files), store, import (Context Compiler keeps one SQLite file for each import)

**Persistent WAL**:
The journal of the SQLite file. SQLite adds each commit to the `-wal` file, and these `-wal` and `-shm` files stay after the last connection closes. Thus a reader that cannot write the folder of the file can read it. Readers never wait for a commit, and a commit never waits for readers.
_Avoid_: WAL mode, journal mode

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
`computed` when the rule made a value, `empty` when it found nothing to keep, and `failed` when it failed on the input. The refresh after the next pass tries a `failed` row again.
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
The table `_elt_next_<hash>` that a reload commits into. When the stream ends with no failure, the raw table takes its rows by difference. The hidden table takes the place of a raw table of a different shape.
_Avoid_: Shadow table, temp table

**Checkpoint file**:
The SQLite file of a `SQLiteCheckpointStore`. It is not a SQLite file of a destination.
_Avoid_: State database

**Sole writer**:
A `SQLiteSyncHistory` whose host knows that no other process runs a pass of its connections. Its install fails the passes that it finds unfinished.
_Avoid_: Leader (the leader of a flight is one host that can be a sole writer), owner

**Epoch**:
The id that names the numbering of the commits of a SQLite file. A file that is made again has a new epoch, and its numbers start again.
_Avoid_: Generation, version

**Position**:
`<epoch>:<number>`: the last commit of a closed load, when no other load has commits before and after it. A reader at a position sees no part of a pass. A reading of a commit that is not a position fails.
_Avoid_: Offset, cursor (eca keeps a cursor), checkpoint

**Row hash**:
`_elt_row_hash`: the SHA-256 of the values of the columns of a row. A file in the SQLite file counts by the SHA-256 of its bytes, not by its file id. It is null in a row that lost or changed a value when its table evolved, until a commit writes the row again. A deduplicating load that finds a stored row with the same row hash leaves that row as it is, and so does a difference.
_Avoid_: Checksum, version, input hash (a computed dataset keeps an input hash)

**File id**:
The `INTEGER` that a file column keeps for one file in its chunk table `_elt_files_<hash>`. Each load gives each file a new id. The ids of a chunk table only go up, so no file takes the id of a file that a row of the history refers to.
_Avoid_: Ref (a file in a file storage has a ref), blob id

**Difference**:
How an overwrite or a reload replaces the rows of a raw table. It compares the rows as multisets by row hash: the k-th copy of some values matches the k-th copy of the same values. A row with a match stays, with its commit. A row of the raw table with no match goes into the history. A new row with no match enters.
_Avoid_: Diff, merge (a commit merges the stage), sync

**History**:
The table `_elt_history_<hash>` that keeps the rows of a raw table that commits changed or removed. Each row has `replaced_in`, the number of the commit that changed or removed it. The file of a row of the history stays, in the SQLite file and in a file storage.
_Avoid_: Audit log, archive, changelog

**Reading**:
A read-only connection to the SQLite file as of one position. Each raw table, reader view and view shows the rows that the commit of the position left. The sync history cannot be read in it.
_Avoid_: Snapshot (SQLite gives each read transaction a snapshot), time travel, version
