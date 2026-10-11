# eca reads the warehouse through a port

The first version of eca took a path for each SQLite import, for example `{ messages: '/path/to/messages/data.sqlite' }`. A host does not have a fixed list like that. The imports of an Apple host are the connectors that the user selects in `settings.sqlite` now, and the user adds and removes them. The Google app keeps its data in one Postgres database, with a schema for each connector, and it has no files. eca must reach the warehouse but stay agnostic to it.

Thus eca defines a port, and the host gives an adapter. The port has two parts: `sql`, the read-only handle that the conditions query, and `commits(signal)`, an async iterable with one item for each commit. eca never opens a file, never sees a path, and does not know the engine. This is the pattern of ports and adapters. It is also the rule of this repository that a package types the ports that its host fills, as `GoogleRequester` does in `google-auth`.

## Considered Options

- **eca opens the SQLite files from their paths.** The list is fixed, eca depends on SQLite, and a Postgres warehouse cannot be used.
- **A package `eca-sqlite` with an adapter for SQLite imports.** No host uses eca yet, so this adapter has no caller apart from the tests.
- **eca types the port, and each host writes its adapter.** This option was selected.

## Consequences

- `Condition<Sql, Data>` and `Eca<Sql, Data>` take the type of the handle of the warehouse. A condition is still written for one engine, because the SQL of SQLite and of Postgres is different.
- Read-only is a choice of the adapter. For example, an adapter opens a SQLite import with `readOnly: true`.
- When a commit is made is also a choice of the adapter. A SQLite adapter can read `PRAGMA data_version`, or the host can report its own commits after each elt pass.
- The tests of eca have their own adapter over a SQLite import. The first host writes the first real adapter.
