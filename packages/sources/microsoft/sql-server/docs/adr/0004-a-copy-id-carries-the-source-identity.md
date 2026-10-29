# A copy ID carries the source identity

`sqlServerCopies` named each copy by its stream, for example `dbo.orders`. Copy IDs must be different across a pipeline. Thus two SQL Server databases that each have a table with the same name could not be in one pipeline: it threw "Pipeline copy IDs must be distinct".

Thus the ID of each copy is `<source identity>/<schema>.<table>`, for example `sql-server:shop/dbo.orders`. The source identity is `sql-server:<database>`, from `SqlServerDatabase.name`. It names what the source reads, not where the server is. Thus a server that a host gets to through a different host name keeps its checkpoints.

## Considered Options

- **Name each copy by its stream.** Two databases with a table of the same name then cannot be in one pipeline.
- **Put the source identity before the stream name.** This option was selected.

## Consequences

- Two databases that each have a table with the same name load next to each other in one pipeline.
- The checkpoint store keeps a checkpoint by copy ID.

## Sources

- Commit 30852f46: the copy ID carries the source identity.
- Commit df71b90d, backlog #2804: a source's identity names what it reads, and SQL Server's identity is `sql-server:<database>`.
