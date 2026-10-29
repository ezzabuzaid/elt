# An overwrite deletes rows and does not truncate

Readers query the warehouse while the loads run. `TRUNCATE` takes an `ACCESS EXCLUSIVE` lock, so a reader would wait until the commit of the overwrite ends.

Thus an overwrite empties its table with `DELETE` in the commit of its stream. Readers see the earlier load until that commit. A reset deletes its scope in the same way.

## Considered Options

- **`TRUNCATE` at the commit.** Readers wait for the commit.
- **`DELETE` at the commit.** This option was selected.

## Consequences

- An overwrite never blocks readers.

Sources: elt 2e420801 (the first Postgres destination: "DELETE-based overwrite so readers are never blocked"); the comment of `src/postgres-overwrite-writer.ts`.
