# elt-postgresql

A host wants the data that elt copies in a Postgres database, with typed columns, which readers query while the loads run. The Postgres destination loads the tables of each connection into one schema, keeps a reader view of each table in a different schema, and publishes documented views. Its checkpoint store and its sync history keep their data in the same database. The words that all of elt uses, for example pass, commit, writer and checkpoint, are in the glossary of [elt](../../elt/CONTEXT.md).

## Language

**Schema**:
The Postgres schema that one `PostgresDestination` loads, for example `google_search_console`. It also holds the checkpoints and the writers of its tables.
_Avoid_: Database (a database holds many schemas), namespace

**Raw table**:
The table that a copy loads, for example `google_search_console.raw_sitemaps`. Readers do not query it.
_Avoid_: Staging table, source table

**Reader view**:
The view that a load keeps of a raw table in a different schema, with `withReaderView`, for example `marts.search_console_sitemaps`. It has the columns and the comments of the table.
_Avoid_: Mart (a mart is the schema `marts`), documented view

**Documented view**:
A view that the application defines with SQL and publishes with `publishPostgresViews`, with a description of the view and of each column.
_Avoid_: Reader view, materialized view

**Comment**:
The native Postgres description of a table, view or column. The descriptions of the source become comments.
_Avoid_: Annotation, metadata

**Stage**:
The session-private `TEMP` table where one stream keeps its operations until its next commit.
_Avoid_: Buffer, staging table

**Hidden table**:
The table `_elt_next_<hash>` that a reload commits into. When the stream ends with no failure, the load gives its rows to the table by difference if the table still has the stream's shape, and swaps it in if not.
_Avoid_: Shadow table, temp table

**Swap wait**:
The time, at most 3 seconds, that a change of a stored table waits for readers to let go before it fails the copy.
_Avoid_: Timeout (a statement timeout is a setting of a role)

**Numbering**:
The commit numbers of a database, in `_warehouse`: one sequence, `_elt_commits`, `_elt_loads` and `_elt_epoch`. Every `PostgresDestination` of the database shares it.
_Avoid_: Version (a version is a row of a table or of its history), log

**Epoch**:
The id that names the numbering of a database. A new database, or one whose `_warehouse` was dropped, has a new epoch, and its numbers start again.
_Avoid_: Generation, version

**Position**:
`<epoch>:<number>`: the last commit of a closed load, when no other load of any schema has commits before and after it. A reader at a position sees no part of a pass.
_Avoid_: Offset, cursor (eca keeps a cursor), checkpoint

**High-water mark**:
The highest commit number below the first number that a commit still holds. Each number at or below it is a commit that a new snapshot sees, or one that rolled back.
_Avoid_: Newest commit (a commit with a higher number can have ended first), watermark

**Row hash**:
`_elt_row_hash`: the SHA-256 of the values of a row, computed when the row is staged. A stored file counts as the SHA-256 of its bytes. A commit that finds the stored row with the same hash leaves it as it is.
_Avoid_: Checksum, version number

**History**:
The table `_elt_history_<hash>` beside a raw table, which keeps each row that a commit replaced or removed, with `replaced_in`.
_Avoid_: Audit log, sync history (the sync history records passes, not rows)

**Widening**:
A change of the type of a column that maps each old value to one value of the new type exactly, with no loss, such as `bigint` to `numeric`, or any type to `text`. The history casts its column for a widening, and each position stays readable.
_Avoid_: Promotion, relaxation (the names that Iceberg and BigQuery use), compatible change

**Min valid**:
`min_valid` in `_warehouse._elt_epoch`: the oldest commit that a reading can read as of. The retention sets it to the newest position older than its window, and a change of type that is not a widening sets it to its own commit; `expired_by` names which one set it last. Each position before it is expired.
_Avoid_: Low-water mark

**Retention**:
How long the history keeps a position readable: a `Temporal.Duration` set on the destination, 30 days unless set. The shortest retention among the destinations of one database decides.
_Avoid_: TTL, expiry (an expired position is what the retention leaves)

**Reading**:
A read-only transaction, of its own session, that sees the database as of one position: each reader view reads `elt.position`.
_Avoid_: Snapshot (a reading has one, but a snapshot alone shows commits inside a pass), time travel
