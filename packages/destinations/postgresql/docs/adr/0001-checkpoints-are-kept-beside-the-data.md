# Checkpoints are kept beside the data

`PostgresCheckpointStore({ url, schema })` saves the binding and the state of each copy in `<schema>._elt_checkpoints`, beside the data. Dropping the schema resets both. Each save is in its own transaction, after the load commits, so delivery is at least once, as with SQLite. A two-key advisory lock for each copy `id` lets copies run in parallel, and a second run of one copy fails fast. The store makes its table in a committed transaction first, so a writer never waits for a checkpoint transaction that is idle. `JSON` columns keep state that `JSONB` would refuse.

## Considered Options

- **A checkpoint store apart from the data, for example a SQLite file.** A drop of the schema then does not reset the checkpoints.
- **A table of checkpoints in the schema of the data.** This option was selected.

## Consequences

- `DROP SCHEMA … CASCADE` resets the data and the checkpoints together.
- The checkpoint store and the destination share the checks of the connection, the URL and the schema.

Sources: elt c9f576c1.
