# No transaction stays open between commits

elt was made ready for a SQL Server source, whose streams are the tables of a database. With a transaction open across the read, a run of 4,000 tables failed: 3,010 of them failed with "out of shared memory".

Thus, as in the `destination-postgres` of Airbyte, no transaction stays open between commits. `prepare` only refuses and stages in `TEMP` tables. Each commit is one transaction. The first commit of a stream also makes the table, the comments, the index, the reader view and the writer.

## Considered Options

- **One transaction for the read of a stream.** Locks grow with the number of tables, and readers and vacuum wait.
- **One short transaction for each commit.** This option was selected.

## Consequences

- A run of 4,000 tables loads, and a failed run leaves nothing of a stream that did not commit.
- The read of the source holds no locks on the targets.

Sources: elt 92dff2fd.
