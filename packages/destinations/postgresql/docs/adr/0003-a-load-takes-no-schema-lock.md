# A load takes no schema lock

Superseded in part on 2026-11-20 (#4886) by [ADR 0010](./0010-readers-look-in-marts-and-elt-keeps-its-tables-in-warehouse.md): the tables of the writers are made in a transaction of their own, under the lock of `_warehouse`, before the commits of a load, so the first commit of a table takes no schema lock.

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
- The first commit of a table is DDL too: it can make the schema and `<schema>._elt_writers`. Datahub loaded several connections into one schema, and four of five first commits failed with `23505` (backlog #3250). Thus the first commit takes the lock of the schema, and makes the schema in a transaction of its own before the commit, which begins only when it holds the lock. A transaction that waits for an advisory lock inside it does not refresh its catalog cache, so its `CREATE SCHEMA IF NOT EXISTS` does not see the schema that the holder made.

Sources: elt ed76393a, d973cd3; #3250.
