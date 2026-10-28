# A changed declaration makes the table again

The raw table of a computed dataset can change its shape. For example, a rule adds a column, or the columns of the engine change. A refresh can make each output row again from the inputs. Thus that data needs no migration.

The raw table is a `Declaration` of `@zukhruf/sqlite-drift`, with `rows: 'replace'`. A refresh compares the stored table with its declaration. When they are different, it makes the table again, and it computes each output row again. The writer of the SQLite destination also compares the stored shape of a stream table with its declared shape.

## Considered Options

- **Migrate the table, for example with `ALTER TABLE`.** This is a migration for data that a refresh can make again.
- **A version number in the SQLite file.** A caller can forget to increase it.
- **Compare the stored table with its declaration, and make it again when they are different.** This option was selected.

## Consequences

- A changed declaration costs one full computation, for example the text of each file is read again.
- No host writes a migration for a computed dataset.
