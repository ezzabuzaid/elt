# Readers are named on the sync history

A reader that reads the database as of a position with its own session, such as the read-only role of an agent, needs the commit numbering in `_warehouse`: `positions()` and `reading()` read `_elt_epoch`, `_elt_commits`, `_elt_loads` and the sequence `_elt_commit_numbers`. Before this decision, apps/proactive granted those four objects to `agent_reader` by hand, and datahub was told to copy the grant (backlog #4492). The names are the destination's own. A host that names them breaks when the destination adds or renames one, and a numbering that is made again loses the grant.

Which role reads is a decision of the host. What a reading needs is a fact of the destination.

Thus the host names its reader roles on the sync history, `new PostgresSyncHistory({ url, readers })`, and each install grants each reader `USAGE` on `_warehouse` and `SELECT` on the numbering, and nothing else. The pipeline installs the history before each run and watch (elt ADR 0013), so the grant follows a numbering that is made again.

## Considered Options

- **The host grants the objects.** The host names objects that are not its own.
- **A method that grants, which the host calls.** The host must call it after the numbering exists, and again after it is made again.
- **The host names the roles, and each install grants them,** as dbt applies the grants that a model declares after each build. This option was selected.
- **Functions of the destination that read the numbering with the rights of their owner.** A reader still needs `USAGE` on their schema, and each query of a reading would change.

## Consequences

- The history is the place, because it owns `_warehouse` and one history serves the database of a pipeline. A destination names one schema, and the numbering is of the whole database.
- When readers are named, the install makes the numbering if the database has none yet.
- Who may read the views of `marts` stays a grant of the database, such as default privileges.

Sources: #4492.
