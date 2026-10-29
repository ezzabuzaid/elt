# Each column is read as the text that SQL Server spells

The source loads every value exactly. The mssql driver does not. It gives `decimal` and `money` as JavaScript numbers, `datetime2` as a `Date` with milliseconds only, and it drops the offset of a `datetimeoffset`.

Thus the SDK has one codec for each family of types. It selects each such column as the text that SQL Server spells, with `CONVERT` styles that keep every digit, and decodes the text into the canonical form of its field. A `datetimeoffset` gives the UTC instant and, next to it, `<column>_offset`, the offset in minutes. A `sql_variant` gives its value as text and, next to it, `<column>_type`, its base type.

## Considered Options

- **Use the values that the driver gives.** Decimals, money and times then lose digits, and offsets are lost.
- **Select each such column as text, and decode the text.** This option was selected.

## Consequences

- Every value loads exactly. The live checks of 2026-10-06 found the styles that keep every digit: style 126 for times, style 2 for money and style 3 for floating point in a `sql_variant`.
- A `datetimeoffset` or `sql_variant` column adds one field next to itself. See ADR 0003 for its name.

## Sources

- Commit 85a12bf2: "The driver hands decimal and money over as JavaScript numbers, datetime2 as a millisecond Date, and drops a datetimeoffset's offset, so each column is selected as the text SQL Server spells it and decoded into its canonical form."
