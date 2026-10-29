# An added field takes the next free name

A `datetimeoffset` column adds the field `<column>_offset`, and a `sql_variant` column adds `<column>_type`. When the table already had a column with that name, discovery threw. Then `SqlServerSource.discover` failed for every table of the database.

Thus the source names each added field one time for each table: `<column>_offset`, or the next free name, `<column>_offset_1`, then `_2`, when a column or an earlier added field has the name. It compares names without case, as the default collation of SQL Server compares them. The properties, the stream key, the records and the Change Tracking deletion keys all read that one name. The description of the column names the field that holds its offset.

## Considered Options

- **Refuse a table whose column has the name of an added field.** One such table then fails the discovery of the full database.
- **Give the added field the next free name.** This option was selected.

## Consequences

- A table with such a column loads, with all its values.
- A reader finds the name of the added field in the description of its column.

## Sources

- Commit bc25975d.
