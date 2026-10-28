# A view names no inputs

A view reads tables that copies make. SQLite makes a view also when a table that it reads is not there, and each read of that view then fails. The hosts before this change made their views themselves. After each pass, they tried the query of each view, and they did not make a view whose query failed. Thus a misspelled table was never reported.

A list of inputs, for example `reads: ['documents']`, can be different from the tables that the SQL reads. The design planned to find the inputs in the SQL with the authorizer of `node:sqlite`, as SQLMesh and Snowflake find the inputs of their models. The shipped rule needs less. A refresh prepares the query of the view. When the query compiles, the refresh makes the view. When SQLite answers `no such table` for a raw table or a reader view that a copy of the pipeline makes in the same SQLite file, the view waits. Any other error is a dataset failure.

## Considered Options

- **The view names its inputs.** The list and the SQL can then be different.
- **The refresh finds the inputs with the authorizer.** This is more code, and preparing the query already gives the answer.
- **The refresh prepares the query, and the view waits for a table that a copy makes.** This option was selected.

## Consequences

- A reader never finds a view that fails.
- A misspelled table fails the run, with the error of SQLite.
- A view that comes after a computed dataset in the list can read the view of that dataset.
- The columns of a view must be the same as its description, and the catalog lists them. A run that changes nothing does not change the schema of the SQLite file.
