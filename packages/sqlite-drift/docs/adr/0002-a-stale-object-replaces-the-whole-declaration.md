# A stale object replaces the whole declaration

When a stored object is not as declared, `apply` must make it as declared. Röthlisberger's migrator keeps the rows: it does the 12 steps of SQLite to change a table, and it copies the rows into the new table. The callers of this package keep data that they can make again. AGENTS.md says that a new run makes stored data again, and that the code has no migrations. A caller that must keep its rows asks `drift` and does the work itself, as the SQLite writer of elt does with `#evolve`.

`node:sqlite` turns on foreign keys by default. SQLite cannot drop a table while rows of another table refer to its rows. Thus `apply` cannot replace only the stale table when another table refers to it. The sync history of elt has such a pair: `_elt_extraction_coverage` refers to `_elt_sync_attempts`.

## Considered Options

- **Change each stale table and keep its rows.** The callers do not need the rows, and the 12 steps cannot change every column, for example a new column that is NOT NULL with no default.
- **Replace only the stale objects.** This fails when another table refers to a stale table.
- **Replace every object of the declaration when one is stale, and only make the missing ones when none is stale.** This option was selected. `apply` drops the stored objects in the reverse order of the declaration, then makes all of them in order.

## Consequences

- One stale table empties every table of its declaration. A caller that wants one table to keep its rows when another changes gives each table its own declaration.
- A declaration lists a table before the tables that refer to it.
- A new object in a declaration keeps the rows of the other objects: `apply` only makes the missing object.
- `apply` does not drop an object that the declaration does not name.
