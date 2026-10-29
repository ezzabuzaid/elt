# A load takes no schema lock

`PostgresLoad.open` held a session advisory lock on the schema for the full load, and `PostgresWriter.clear` held it across its commit. The lock protected no case that a host can make:

- Two runs of one copy: `PostgresCheckpointStore` holds the key of each copy for the run and for a clear, and the replication takes it before `destination.load()`.
- Pending file chunks are staged in `pg_temp` and get to the store with their rows, so no other load can remove them.
- Each host loads its own schema: the Google app its raw schema, and each SQL Server connector `sql_server_<name>`.

Thus a load takes no schema lock, and loads into one schema run side by side.

The DDL locks stay. They are transaction locks on the schema around the table that `PostgresCheckpointStore` makes, `publishPostgresViews` and `PostgresSyncHistory.install`, which each app runs at start against the shared warehouse. A probe on `postgres:18` showed that when four sessions run `CREATE SCHEMA IF NOT EXISTS` together, 3 of 4 fail with `23505` on `pg_namespace_nspname_index`, in 40 of 40 trials.

## Considered Options

- **A schema lock for each load.** Loads into one schema wait for each other with no case to protect.
- **No schema lock on a load; a lock only around DDL.** This option was selected.

## Consequences

- A second load or clear of a schema does not wait for one that runs. A checkpoint store keeps runs of one copy apart, as each host does.
- Two first loads into a new schema that start at the same moment can fail one time. No host starts them in that way.

Sources: elt ed76393a, d973cd3.
