# The file storage compares the names of its files by their bytes

Status: accepted (2026-11-22, #5170 step E3).

`SqlServerDestination.files()` gives a file storage in the database of the destination, as `files()` of elt-sqlite and elt-postgresql does. The three are subclasses of `DatabaseFiles` of elt, which owns the content hash, the chunks, the pending name, the reconcile, the temporary copy and the missing ref. Each subclass has only its SQL. Ezz ruled that the database is one more file storage with the interface of `LocalFiles` (2026-11-22: "treat the db as local files ... same interface so we don't need to rebuild machinery once more"), so that datahub keeps its SharePoint documents in Azure SQL while its writer moves between containers with fresh disks.

The table is `_warehouse._elt_files`: `[scope] char(64)`, `[name] varchar(128)`, `[n] bigint`, `[bytes] varbinary(max)`, with the key `([scope], [name], [n])`. Three rules of SQL Server make its shape differ from SQLite and Postgres:

- **A name compares by its bytes.** The collation of a database can ignore case, as `SQL_Latin1_General_CP1_CI_AS` does, the default of SQL Server. Two files with the same bytes and the extensions `.PDF` and `.pdf` then have the same name for the server. The save of the second would find the first and give a ref that differs from the stored name, and the next reconcile would find no file for that ref and fail the copy. Thus `[scope]` and `[name]` are `COLLATE Latin1_General_BIN2`, as SQLite (`BINARY`) and Postgres compare text by default.
- **A parameter is cast to the type of its column.** Each parameter of `SqlServerConnection.query` is an `nvarchar(max)`. An `nvarchar` value compared with a `varchar` column converts the column, and the key cannot seek. Thus each statement casts `@scope` to `char(64)` and each name to `varchar(128)`. A name is at most 64 hex digits and an extension of 17 characters, or `.pending-` and a UUID.
- **A chunk travels as base64 in one JSON parameter.** `OPENJSON` reads it as `varchar(max)`, because `BASE64_DECODE` takes no `nvarchar` (error 8116, [ADR 0011](./0011-a-batch-travels-as-one-json-parameter-that-openjson-reads.md)). This is the statement of the chunks of `blob().from(file)`, which #5170 step E1 removed. A read gives `varbinary(max)`, which `mssql` gives as a `Buffer`.

## Considered Options

- **The collation of the database.** It ignores case on most servers, and the reconcile of a scope with `.PDF` and `.pdf` of one file fails the copy.
- **`COLLATE Latin1_General_BIN2` on the columns of the key.** This option was selected.
- **`varbinary` names, such as the SHA-256 as `binary(32)`.** A name also holds its extension, and a ref is text, so each statement would convert between the two.

## Consequences

- The table and its key are the same three ideas as in SQLite and Postgres, so the README of each destination describes one table.
- A test stores `upper.PDF` and `lower.pdf` with the same bytes in a database of the default collation, and reconciles both refs.

Sources: backlog #5170; elt ADR 0030; elt-sqlserver ADR 0011; `git show c4e9a716^:packages/destinations/sqlserver/src/sql-server-file-store.ts`.
