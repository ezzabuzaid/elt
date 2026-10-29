# A target is named by its address inside the destination

`Destination.location(target)` goes into the checkpoint binding of each incremental copy and into the scope of its stored files. Before, it named where the destination is: `<absolute path>#<table>` for SQLite and `//host:port/database/"schema"."table"` for Postgres. An Apple import that a user copied to a different home folder, or a warehouse that a host reached at `127.0.0.1` in place of `localhost`, then refused each checkpoint (`Checkpoint binding changed`) and had to load again from the start.

Thus `location(target)` is the address of the target in the destination: the table name for SQLite, and `"schema"."table"` for Postgres. Airbyte also keys state by connection and stream, not by host.

## Considered Options

- **Name the target by its path or its host.** A move or a different host name loses each checkpoint.
- **Name the target by its address in the destination.** This option was selected.

## Consequences

- A destination that moves, or that a host reaches in a different way, keeps its checkpoints and stored files.
- A source identity also never names where its store is. A host that reads a second store of one kind keeps it apart with its own checkpoint store.
- The pipeline check that two copies in one pipeline write one table used the global location, so it was deleted. The `_elt_writers` check of each destination still refuses a second writer.

Sources: elt 05075913; backlog #2804.
