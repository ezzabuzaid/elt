# A change of a table refreshes the views over it

Status: accepted by Ezz (2026-11-19).

elt-postgresql ADR 0006 saves, drops and makes again each view over a table that a change replaces, because Postgres binds a view to the OID of its tables and refuses `DROP TABLE` while a view reads it. SQLite finds the tables of a view by name at each read, so it needs nothing.

SQL Server is close to SQLite. A view without `SCHEMABINDING` finds its tables by name when SQL Server compiles a query on it, so a table can be dropped, renamed or changed under it. But SQL Server keeps the column list of the view as it was made, so a view that selects `*` shows the old columns until `sp_refreshview` reads its definition again ([sp_refreshview](https://learn.microsoft.com/sql/relational-databases/system-stored-procedures/sp-refreshview-transact-sql)). A view `WITH SCHEMABINDING` refuses each change of the tables that it reads.

## Decision

- In the transaction of a change of shape or of the swap of a reload, the destination finds each view that reads the table, its history or its reader view, directly or through other views (`sys.sql_expression_dependencies`), and runs `sp_refreshview` on each one, the shallowest first.
- A view that does not fit the change, such as one that reads a column that the change drops, fails `sp_refreshview`. The change then fails, the error names the view, and the table and the checkpoint stay as they were, as in Postgres.
- A view `WITH SCHEMABINDING` stops the change. The error names the view.
- The views keep their owners, grants and extended properties, because nothing drops them. A swapped-in table takes the grants of the old table.

## Considered Options

- **A port of elt-postgresql ADR 0006: save, drop, and make again.** SQL Server does not need it, and each make would lose what the save does not know.
- **Nothing.** A view over `*` then shows the old columns.
- **`sp_refreshview` for each dependent view.** This option was selected.

## Consequences

- A view that a person or an agent made over a reader view reads the new table after a reload, with its grants.
- To probe before code: `sp_rename` of a table that a view reads, then `sp_refreshview`; and the error number of a `SCHEMABINDING` view.

Sources: elt-postgresql ADR 0006; backlog #3185.
