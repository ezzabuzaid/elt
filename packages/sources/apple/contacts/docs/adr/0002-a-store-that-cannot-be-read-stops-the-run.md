# A store that cannot be read stops the run

All 24 streams are snapshot streams. A snapshot diff deletes each key that is not in the read. If the source read a store that it cannot open as empty, the diff would delete all rows of that account from each target.

Thus a store or a `Sources` folder that the source cannot open fails the run with `ContactsUnavailableError`. A store without a column that the source reads fails with `MissingColumnsError`, and a store without a Core Data entity that the source reads fails with `ContactsSchemaError`. A renamed entity matches no rows, so the source checks the entities before it reads. Each error comes before a copy starts.

## Considered Options

- **Skip the store and read the others.** The diff then deletes the rows of the skipped account.
- **Stop the run.** This option was selected.

## Consequences

- A failed run keeps the rows of the last good run.
- `ContactsUnavailableError` is a config failure, so a host can tell the user to give the Contacts grant or Full Disk Access.

## Sources

- b1576757: a store, column or entity that the connector cannot read throws `ContactsUnavailableError` or `ContactsSchemaError` instead of reading an account as empty.
- 929bba7b (#2341): each failure says whose it is to fix, and the Apple sources map their `*UnavailableError` to a config failure.
