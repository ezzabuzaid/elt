# elt-postgresql

A host wants the data that elt copies in a Postgres database, with typed columns, which readers query while the loads run. The Postgres destination loads each stream into a raw table in `_warehouse`, keeps a reader view of each raw table in `marts`, and keeps the views and computed datasets that the pipeline derives from them. Its checkpoint store and its sync history keep their data in the same database. The words that all of elt uses, for example pass, commit, writer and checkpoint, are in the glossary of [elt](../../elt/CONTEXT.md).

## Language

**Schema**:
One of the two Postgres schemas of a database, which the destination fixes. `marts` holds each relation that readers query, and each one is a view. `_warehouse` holds each table of elt: the raw tables, their histories, the writers, the checkpoints, the numbering and the sync history. A host names no schema.
_Avoid_: Database (a database holds the two schemas), namespace

**Reader name**:
The name that a host gives to `table`, for example `search_console_sitemaps`. It names the reader view in `marts`, and the destination derives the name of the raw table from it. It follows the naming rule of elt.
_Avoid_: Target name, table name

**Raw table**:
The table that a copy loads, `_warehouse.raw_<name>` for the reader name `<name>`, for example `_warehouse.raw_search_console_sitemaps`. Readers do not query it.
_Avoid_: Staging table, source table

**Reader view**:
The view `marts.<name>` that a load keeps of its raw table, for example `marts.search_console_sitemaps`. Each copy has one. It shows the external schema of the stream, its columns and `loaded_at`, with their comments. The internal columns `committed_in`, `_elt_row_hash` and `replaced_in` are for the SQL of the destination only.
_Avoid_: Mart (a mart is the schema `marts`), view (a view is a derived dataset)

**View**:
A derived dataset that Postgres computes on each read, such as `marts.unread_count`: a `View` that a pipeline declares in `derived`. It appears when its query compiles, and it waits while a relation that the pipeline makes is missing. See the glossary of [elt](../../elt/CONTEXT.md).
_Avoid_: Documented view, reader view (a reader view is the view of one raw table)

**Computed dataset**:
A derived dataset that a rule computes on write, one row for each input key, in the table `raw_<name>` with the view `<name>`, such as `marts.document_text`.
_Avoid_: Materialized view (Postgres refreshes a materialized view whole)

**Declared index**:
An index that a computed dataset declares on its raw table (`indexes`): a btree index over key columns, or an HNSW vector index over a vector column with its metric. The destination names it `ix_elt_<hash>` from the statement that makes it, which holds the table, and reconciles the declared indexes with `pg_index` at each refresh, so an index of another name, such as a person's own, stays.
_Avoid_: Hook, post-hook (dbt's word)

**Comment**:
The native Postgres description of a table, view or column. The descriptions of the source become comments.
_Avoid_: Annotation, metadata

**Stage**:
The session-private `TEMP` table where one stream keeps its operations until its next commit.
_Avoid_: Buffer, staging table

**Hidden table**:
The table `_elt_next_<hash>` that a reload commits into. When the stream ends with no failure, the load gives its rows to the table by difference if the table still has the stream's shape, and swaps it in if not.
_Avoid_: Shadow table, temp table

**Dependent view**:
A view, or a materialized view, that reads a raw table, its history or its reader view, directly or through other views, for example a view that an agent made over `marts.search_console_sitemaps`. A change of the table makes it again over the new table, with its owner, comments and privileges.
_Avoid_: Downstream object, dependency (a dependency is the relation that a view reads)

**Swap wait**:
The time, at most 3 seconds, that a change of a stored table waits for readers to let go before it fails the copy.
_Avoid_: Timeout (a statement timeout is a setting of a role)

**Numbering**:
The commit numbers of a database, in `_warehouse`: one sequence, `_elt_commits`, `_elt_loads` and `_elt_epoch`. Every `PostgresDestination` of the database shares it.
_Avoid_: Version (a version is a row of a table or of its history), log

**Epoch**:
The id that names the numbering of a database. A new database, or one whose `_warehouse` was dropped, has a new epoch, and its numbers start again.
_Avoid_: Generation, version

**Load**:
A row of `_warehouse._elt_loads`: one pass of a connection, under the name of the connection in `connector`, or one refresh of a computed dataset, under its name in `dataset`. A load of a connection opens when the pass starts to load, and closes when the pass ends. A load that opens closes each load of the same connector or dataset that is still open, because the process of that load ended first. A closed load cannot commit. A clear is a load of one commit.
_Avoid_: Batch, job, run (a run is one call of `pipeline.run()`)

**Position**:
`<epoch>:<number>`: the last commit of a closed load, when no other load of the database has commits before and after it. A reader at a position sees no part of a pass.
_Avoid_: Offset, cursor (eca keeps a cursor), checkpoint

**High-water mark**:
The highest commit number below the first number that a commit still holds. Each number at or below it is a commit that a new snapshot sees, or one that rolled back.
_Avoid_: Newest commit (a commit with a higher number can have ended first), watermark

**Row hash**:
`_elt_row_hash`: the SHA-256 of the values of a row, computed when the row is staged. A commit that finds the stored row with the same hash leaves it as it is.
_Avoid_: Checksum, version number

**History**:
The table `_elt_history_<hash>` beside a raw table, which keeps each row that a commit replaced or removed, with `replaced_in`.
_Avoid_: Audit log, sync history (the sync history records passes, not rows)

**Widening**:
A change of the type of a column that maps each old value to one value of the new type exactly, with no loss, such as `bigint` to `numeric`, or any type to `text`. The history casts its column for a widening, and each position stays readable.
_Avoid_: Promotion, relaxation (the names that Iceberg and BigQuery use), compatible change

**Min valid**:
`min_valid` in `_warehouse._elt_epoch`: the oldest commit that a reading can read as of. The retention sets it to the newest position older than its window, and a change of type that is not a widening, or a clear, sets it to its own commit; `expired_by` names which one set it last. Each position before it is expired.
_Avoid_: Low-water mark

**Retention**:
How long the history keeps a position readable: a `Temporal.Duration` set on the destination, 30 days unless set. The shortest retention among the destinations of one database decides. When the retention moves min valid, it deletes the commits before it and the closed loads that have no commit left.
_Avoid_: TTL, expiry (an expired position is what the retention leaves)

**Reading**:
A read-only transaction, of its own session, that sees the database as of one position: each reader view reads `elt.position`.
_Avoid_: Snapshot (a reading has one, but a snapshot alone shows commits inside a pass), time travel

**Reader role**:
A Postgres role that a host names in `readers` of `PostgresSyncHistory`, for example `agent_reader`. It calls `positions()` and `reading()` with its own session. Each install grants it `USAGE` on `_warehouse` and `SELECT` on the numbering, and nothing else; who may read `marts` is a grant of the database. See [ADR 0007](./docs/adr/0007-readers-are-named-on-the-sync-history.md).
_Avoid_: Reader user, grantee, reader (any session that queries `marts` is a reader)
