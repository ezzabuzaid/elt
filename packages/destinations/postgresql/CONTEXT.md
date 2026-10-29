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
The table `_elt_next_<hash>` that a reload commits into. The load swaps it in when the stream ends with no failure.
_Avoid_: Shadow table, temp table

**Swap wait**:
The time, at most 3 seconds, that a change of a stored table waits for readers to let go before it fails the copy.
_Avoid_: Timeout (a statement timeout is a setting of a role)
