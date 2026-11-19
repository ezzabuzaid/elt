# The SQL Server destination takes the declarations of elt-postgresql

Status: accepted by Ezz (2026-11-19).

Datahub keeps the datasets of its semantic layer in a SQLite file today, and it computes vectors of staff text (backlog #4738). Ezz chose on 2026-11-19 that these datasets, and the vectors, live in Azure SQL, where datahub already keeps its other data (backlog #4736). elt has a SQLite destination and a Postgres destination. Both give the same contract: one writer for each target (elt ADR 0008), the location of a target inside its destination (elt ADR 0009), evolve and reload (elt ADRs 0006, 0007), numbered commits with positions, a history of each row and retention (elt-sqlite ADR 0009), a clear that forgets (elt ADR 0023), views and computed datasets (elt-postgresql ADR 0008), and the status of each derived dataset (elt ADR 0025).

A host must change its destination and nothing else of its pipeline. elt-postgresql ADR 0008 set this rule for Postgres against SQLite.

## Decision

- The SQL Server destination takes the declarations of elt-postgresql: one schema for each `SqlServerDestination`, `table(name, columns)`, `withReaderView(schema, name)`, `View`, `ComputedDataset`, a checkpoint store and a sync history in the same database, `_warehouse` for the numbering and the history, and `marts` for the views of the history and the catalog.
- Readers see the same columns: the external schema of each stream, and the key, engine columns and rule columns of a computed dataset.
- Where SQL Server is different, the destination meets the difference inside, and an ADR of this package records it:

| Difference of SQL Server                                                                         | What the destination does                                              |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| No advisory lock on a number; a database-wide `rowversion` and `MIN_ACTIVE_ROWVERSION()`         | The commit number is a rowversion (ADR 0002)                           |
| No row locator such as `ctid` or `rowid`                                                         | Each raw table has an identity column (ADR 0003)                       |
| An index key holds at most 1,700 bytes; `NVARCHAR(MAX)` cannot be one; keys compare by collation | The unique index is on a hash of the key (ADR 0004)                    |
| `MERGE`, `OUTPUT` and composable DML                                                             | One `MERGE` for each commit, whose output feeds the history (ADR 0005) |
| Views find their tables by name                                                                  | A change of a table refreshes its views (ADR 0006)                     |
| A native `VECTOR(n)` type                                                                        | A rule column can be a vector (ADRs 0007, 0008)                        |
| `sp_getapplock`                                                                                  | Each lock is an application lock (ADR 0009)                            |
| `SESSION_CONTEXT` and `SNAPSHOT` isolation                                                       | A reading sets its position in the session context (ADR 0010)          |
| `OPENJSON`; tedious has no `VECTOR` and no `JSON` on the wire                                    | A batch travels as one JSON parameter (ADR 0011)                       |

## Considered Options

- **Declarations of its own,** such as a database in place of a schema, or a vector store with its own API. A host would declare its pipeline again for each destination.
- **A SQL Server destination of Airbyte, dlt or Fivetran, beside elt.** None keeps elt's positions, history, derived datasets or checkpoints; a second tool would own the copies of one pipeline.
- **The history as a system-versioned temporal table.** SQL Server keeps a current table and a history table by itself, and elt-sqlite ADR 0009 took the shape of its history from it. But a temporal table stamps each version with the begin time of its transaction (`datetime2`), and commits run side by side, so the time does not order the commits, and a position names a commit. A temporal table also writes a version for an update that sets the same values, refuses a delete from its history while versioning is on, so a clear cannot forget (elt ADR 0023), and drops a column from its history when the table drops it ([temporal table considerations](https://learn.microsoft.com/sql/relational-databases/tables/temporal-table-considerations-and-limitations)).
- **The declarations of elt-postgresql, with the differences met inside.** This option was selected.

## Consequences

- datahub moves from `SQLiteDestination` to `SqlServerDestination` and keeps its views, computed datasets and readers of `derived_status`. Its SQL changes only where SQLite SQL and T-SQL differ.
- The destination needs SQL Server 2025, Azure SQL Database, or Azure SQL Managed Instance with the always-up-to-date policy, for the `VECTOR` and `JSON` types.
- This is the third destination that keeps the shared rules. ADR 0012 moves them into elt before this destination is built, and the destination takes them from there.

Sources: backlog #4736, #4738; elt-postgresql ADR 0008.
