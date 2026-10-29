# Each checkpointed copy has its own lock

`SQLiteCheckpointStore` held one `BEGIN IMMEDIATE` transaction on its file for a full run, only as a lock. Runs that shared the file ran one at a time, and a second run failed with the lock error of SQLite.

Thus the store holds one key of `@zukhruf/mutex` (`SqliteStore`) for each copy `id`, in a `<path>.locks` folder, and it skips a key that is busy. This is what the advisory locks of `PostgresCheckpointStore` do. A copy that already runs fails fast with `Checkpoint <id> is in use by another run`. The other copies run in parallel, and each save commits by itself. The kernel releases a key when its process stops.

## Considered Options

- **One transaction on the file for the full run.** Runs of different copies wait for each other.
- **One lock for each copy `id`.** This option was selected.

## Consequences

- Different copies that share one checkpoint file run side by side.
- Each acquire writes a durable fencing token, about 9 ms for each key, so a run starts 120 to 220 ms later.

Sources: elt 229349b2; backlog #2433.
