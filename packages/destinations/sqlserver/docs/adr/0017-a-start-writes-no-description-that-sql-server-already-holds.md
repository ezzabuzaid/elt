# A start writes no description that SQL Server already holds

Status: accepted (2026-11-24, #5473).

SQL Server keeps no row versions of metadata. A `SNAPSHOT` transaction that reads an object after another transaction changed the metadata of that object, after the snapshot began, fails with error 3961 ("Snapshot isolation transaction failed … because the object accessed by the statement has been modified by a DDL statement in another concurrent transaction since the start of this transaction"). The error ends the transaction. A reading (ADR 0010) is one `SNAPSHOT` transaction.

`sp_updateextendedproperty` is such a change, also when the new value is equal to the stored value (probe below). Each start of a pipeline writes the descriptions of the views that it declares: `SqlServerSyncHistory.install` writes those of the sync history views and of `marts.catalog`, and the first refresh of each `View` and each `ComputedDataset` writes those of its view. Before this decision, each of these writes ran `sp_updateextendedproperty` on each view and on each of its columns. Thus each start failed each reading that was open before it, at its next read of one of these views. datahub saw it on Azure SQL on 2026-11-22 and 2026-11-24: its staffing alert check failed with 3961 about two times at each start of its writer, and not after the writer settled.

When the declaration did not change, the other statements of a start change no object of the database (probe below):

| Statement at a start                                                                                                 | When the declaration did not change                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `CREATE SCHEMA`, `CREATE TABLE` and `CREATE SEQUENCE` of `_warehouse`, `marts` and the sync history (`IF … IS NULL`) | does not run                                                                                                   |
| `CREATE OR ALTER VIEW` of a `View`, a sync history view and `marts.catalog` (`publishViews`)                         | does not run: `OBJECT_DEFINITION` is equal (ADR 0006)                                                          |
| `sp_refreshview` of the views over a changed view                                                                    | does not run: no view changed                                                                                  |
| `CREATE TABLE` of a stream, its history, its reader view, and their descriptions (`#create`)                         | does not run: only the first commit of a stream makes them                                                     |
| `CREATE INDEX`, `DROP INDEX` of a computed dataset (`TableIndexes.reconcile`)                                        | does not run: `sys.indexes` has each declared index                                                            |
| `CREATE OR ALTER FUNCTION` of a search (ADR 0014)                                                                    | does not run: `OBJECT_DEFINITION` is equal (read in the code; SQL Server 2025 in Docker makes no vector index) |
| `CREATE TABLE` of `#elt_stage_*`, and `DROP TABLE IF EXISTS` of `_elt_next_*`                                        | changes `tempdb`, or no object of the database                                                                 |
| `GRANT SELECT` of the numbering to each reader of the sync history                                                   | runs; a `GRANT` does not cause error 3961 (probe below)                                                        |
| `sp_updateextendedproperty` of each description of a view                                                            | ran each time: the defect                                                                                      |

## Decision

`TargetDescriptions.write` reads the stored value of each `MS_Description` property and compares it with the description by its bytes (`CAST(… AS varbinary(8000))`). It runs `sp_updateextendedproperty` only when they differ, `sp_addextendedproperty` only when the object has no property, and `sp_dropextendedproperty` only when the description is null. A start whose declarations equal what the database holds thus changes no object, and a reading that was open before it reads each view.

The comparison is by bytes, as in ADR 0015: the collation of the database compares text without case, and `=` ignores trailing spaces, so a description that changes only in case would not reach SQL Server.

A start that changes a declaration still changes its object, and a reading that was open before it and reads that object then fails with error 3961. This is correct: the object is not the object that the snapshot began with, and SQL Server cannot show the earlier one. The host reads again in a new reading.

## Considered Options

- **The reader catches error 3961 and reads again.** Each reader then needs the retry, and the retry hides a writer that changes the warehouse at each start for no reason.
- **A lock around the declaration.** The lock of `marts` already serializes the writers. A `SNAPSHOT` reader takes no lock that the change waits for, so the change commits and the reading fails after it. Each reading would have to hold an application lock for its whole life, each start would then wait for each open reading, and the needless writes would still run.
- **Compare the stored value with the declared value, and change only what differs.** This option was selected. It is the rule that `publishViews` already uses for the definition of a view (ADR 0006), and that elt-postgresql uses for its comments (`IS DISTINCT FROM` in `publishPostgresViews`).

## Consequences

- A deploy that restarts the writer with the same declarations fails no reading.
- The datahub staffing check also failed once with error 208 ("Invalid object name 'staff_availability'") at a start. The probes in Docker did not make error 208: a rewritten description gave 3961 to a reading that read the view by its schema-qualified name, by its bare name as a user whose default schema is `marts`, and while the description write was not committed yet. The cause of that error is not known.

Sources: backlog #5473; `src/restart.test.ts`.

## Probe (2026-11-24): what makes a `SNAPSHOT` reading fail

SQL Server 2025 in Docker (`mcr.microsoft.com/mssql/server:2025-latest`), with `ALLOW_SNAPSHOT_ISOLATION ON`. Session A began a `SNAPSHOT` transaction and read `dbo.t`; session B then ran the change; session A then read each object.

```text
change of session B                                      read of session A                   result
EXEC sp_updateextendedproperty … 'VIEW', 'v' (same value)   SELECT * FROM dbo.v                 3961
                                                            SELECT * FROM dbo.w                 ok
                                                            SELECT * FROM sys.extended_properties ok
SELECT 1                                                    SELECT * FROM dbo.v                 ok
CREATE TABLE dbo.u (a int)                                  SELECT * FROM dbo.v                 ok
CREATE TABLE #u (a int)                                     SELECT * FROM dbo.v                 ok
CREATE OR ALTER VIEW dbo.w AS … (same definition)          SELECT * FROM dbo.w                 3961
GRANT SELECT ON dbo.t TO [r] (already granted)              SELECT count(*) FROM dbo.t          ok
GRANT SELECT ON dbo.s TO [r] (new)                          SELECT count(*) FROM dbo.s          ok
CREATE INDEX i ON dbo.u (a)                                 SELECT count(*) FROM dbo.u          3961
```

A pipeline of one copy, one `View` and one `ComputedDataset` with an index ran once. A reading was then opened for each view of `marts`, and a second `Pipeline` with the same declarations ran. Before this decision, the reading of each view whose descriptions the start wrote failed with 3961: `marts.catalog`, `derived_status`, `extraction_coverage`, `record_count`, `sizes`, `stream_status`, `sync_attempts` and `sync_status`. The reader view `marts.records`, whose descriptions only its first commit writes, did not fail. After it, no reading fails.
