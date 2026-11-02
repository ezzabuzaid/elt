# The variant is JSON text with sorted keys

A supertab variant has three fields, `_0`, `_1` and `_2`, and Dia does not name them. On 2026-11-02, one archive held the keys of the 15 supertab variants in four different orders. Swift gives no order to the keys of a dictionary, so the order can change at each write.

## Considered Options

- **A column for each field of each case.** Dia does not name the fields, so the columns would have names that tell nothing. A new case would need new columns.
- **The variant as Dia wrote it.** A write that only moves keys changes the text, and each pass writes the supertabs again.
- **The variant as JSON text with sorted keys.** This option was selected.

## Consequences

- The `variant` column keeps each field of each case, also of a case that Dia adds later.
- A write of the archive that changes no value writes no row.
- The `kind` column gives the case, and the `url` column gives the URL of a web page, so a query of web pages does not parse JSON.
