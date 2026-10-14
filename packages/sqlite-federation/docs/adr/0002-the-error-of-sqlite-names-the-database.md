# The error of SQLite names the database

The handle must know which databases a statement reads before it can attach them. When a statement names a schema that is not attached, SQLite fails with `no such table: <name>.<table>`. That error gives the name. The handle attaches the database with that name and runs the statement again. It does this again for each name that is missing. The handle never parses the statement.

A name that the host cannot locate fails with the error of SQLite. A table that a database does not have also fails with that error, because the handle does not attach a database two times in one statement.

## Considered Options

- **Parse the statement and find each schema name.** The package must then know the full grammar of SQLite, for example common table expressions, subqueries and quoted names.
- **Each condition declares its databases.** The list can differ from the SQL.
- **The error of SQLite names each missing database.** This option was selected.

## Consequences

- The handle depends on the words of the error of SQLite. The test "a statement reads a database that it names by schema" fails if those words change in a new Node or SQLite.
- A statement runs one time for each database that is not attached, plus one time. Each failed run stops when SQLite prepares the statement, before it reads data.
- A name is the text before the first dot in the error. A name that contains a dot cannot be attached.
