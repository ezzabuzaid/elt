# SQL Server

A host wants the tables of a SQL Server database in its warehouse, with a read-only login and nothing enabled on the server. The SQL Server source discovers one stream for each table that the login can read, and reads each table with the best sync strategy that the table and the login allow. The words that all of elt uses, for example stream, copy, checkpoint and reset, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Discovery**:
The step that lists the readable user tables of one database and makes a stream for each of them, with its fields and its sync strategy. A host discovers the source again on each run.
_Avoid_: Scan, introspection, catalog read

**Sync strategy**:
How a stream reads its table: Change Tracking, rowversion or full refresh. Discovery selects the first strategy that the table and the login allow.
_Avoid_: Sync mode (a sync mode is elt's `incremental` or `full_refresh`), method, cursor

**Position**:
Where a Change Tracking stream is in the change history of its table: a Change Tracking version and the tracking generation of the table.
_Avoid_: Cursor, offset, watermark, version (the version is one part of the position)

**Tracking generation**:
The table's `begin_version` and the creation time of its change table. A `TRUNCATE` or enabling tracking again starts a new generation.
_Avoid_: Epoch, history version

**Change history**:
What Change Tracking keeps of the changes of a table, from its minimum valid version to the database's current version.
_Avoid_: Change log, CDC (CDC is a different SQL Server feature, which the source does not read), journal

**Source identity**:
`sql-server:<database>`. It names the database, not the server. It is the first part of each copy ID.
_Avoid_: Connection name, server, location
