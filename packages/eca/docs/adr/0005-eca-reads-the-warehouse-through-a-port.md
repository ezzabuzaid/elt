# eca reads the warehouse through a port

The first version of eca took a path for each SQLite import, for example `{ messages: '/path/to/messages/data.sqlite' }`. A host does not have a fixed list like that. The imports of an Apple host are the connectors that the user selects in `settings.sqlite` now, and the user adds and removes them. The Google app keeps its data in one Postgres database, with a schema for each connector, and it has no files. eca must reach the warehouse but stay agnostic to it.

Thus eca defines a port, and the host gives an adapter. The port has two parts: `stable(after)`, the positions of the warehouse after one, and `read(position?)`, a reading `{ sql, position, at }` of the warehouse as of a position, with the read-only handle that the conditions query. Each gives `{ expired }` for a position that the warehouse can no longer read. eca never opens a file, never sees a path, and does not know the engine. This is the pattern of ports and adapters. It is also the rule of this repository that a package types the ports that its host fills, as `GoogleRequester` does in `google-auth`.

## Considered Options

- **eca opens the SQLite files from their paths.** The list is fixed, eca depends on SQLite, and a Postgres warehouse cannot be used.
- **A package `eca-sqlite` with an adapter for SQLite imports.** No host uses eca yet, so this adapter has no caller apart from the tests.
- **eca types the port, and each host writes its adapter.** This option was selected.

## Consequences

- `Condition<Sql, Data>` and `Eca<Sql, Data>` take the type of the handle of the warehouse. A condition is still written for one engine, because the SQL of SQLite and of Postgres is different.
- elt's SQLite and Postgres destinations give `positions(after?)` and `reading(position?)`, so the adapter is two lines. A reading of elt-sqlite is a read-only connection; one of elt-postgresql is a `READ ONLY` transaction of its own session.
- eca disposes each reading, with `Symbol.dispose` or `Symbol.asyncDispose`, as soon as its steps have evaluated.
- The tests of eca run a real elt pipeline into a real SQLite destination and use that adapter.

Superseded in part on 2026-11-13 (#4253) by [ADR 0010](./0010-eca-is-a-stateless-reader-over-warehouse-positions.md): the port had `sql` and `commits(signal)`, and a commit was the event.
