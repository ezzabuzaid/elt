# A clear forgets the rows it removes

The SQLite and Postgres destinations keep a history of each row that a commit replaced or removed, so a reading as of a position reads exactly. A clear copied the rows that it emptied into that history, which kept them for the retention, 30 days by default, with their stored files. On 2026-11-18 datahub cleared its SharePoint copies, because it may keep nothing of a site outside one folder. The table was empty, and its history still held 6,041 rows of the whole site and pinned 717 stored documents (backlog #4635). The only ways out were to wait for the retention or to delete the database.

A clear is the Clear of Airbyte: the data of the copy goes. A history that keeps it after the clear makes the clear a soft delete.

Thus a clear forgets the rows that it removes. Its commit C deletes them without a copy in the history. It expires each position before C, with the reason that a clear forgot the rows of its table, and the history of the table keeps no row that only those positions read. The stored files that only those rows referred to go with them.

## Considered Options

- **The clear keeps the rows in the history.** Each position stays readable, and the data stays for the retention. This was the rule.
- **A purge of one table's history, beside the clear.** Positions before the purge then read the table as empty, which is false. A host must also know to call it.
- **The clear forgets, and expires the positions before it.** Delta Lake does the same for data that must go: a `DELETE`, then a `VACUUM`, after which time travel to a version before it fails instead of reading the deleted data. A change of type that is not a widening already expires positions in Postgres in this way. This option was selected.

## Consequences

- A host that must keep nothing of a scope, such as data that it no longer may hold, clears the copy and loads it again.
- A reading or `positions(after)` before the clear gives `{ expired }`. A reader such as eca starts again from a newer position.
- One numbering serves each destination of a file or database, so a clear expires the positions before it for every table. Rows of the history of other tables that only those positions read go at the next commit of their table, or with the retention.

Sources: #4635.
