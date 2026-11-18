# Derived datasets follow elt-sqlite

The derived datasets of elt (ADR 0001 of elt) shipped for SQLite first: `View` and `ComputedDataset`. Datahub moved to Postgres for production (2026-11-18), and its pipeline declares both kinds (backlog #3186). The Postgres kinds take the same declarations and give readers the same columns, so a host changes its destination and nothing else of its derived data.

Postgres differs from SQLite in four ways that the kinds must meet:

- **Postgres binds a view to the relations that it reads, and refuses `CREATE VIEW` while one is missing.** A view waits while Postgres reports a missing relation (`42P01`) that a copy of the pipeline makes, or that a derived dataset before it makes, as the SQLite view waits on `no such table`. A replace of a view makes its dependent views again (ADR 0006).
- **Postgres keeps the definition of a view as it normalizes it, not as its text.** To leave an unchanged view as it is, with its OID, its grants and its readers, a refresh makes the query as a `TEMP` view in a savepoint and compares the two definitions.
- **A load has one session, and Postgres runs one transaction at a time on it.** The rule calls of a computed dataset run side by side, and their commits take turns through a `Lock`. Each call still commits as it settles (ADR 0003 of elt-sqlite).
- **A database has many schemas.** A view and a computed dataset live in the schema of `into`, and the bare names of a view are found there.

The catalog of `marts` listed its tables too. A computed dataset in `marts` keeps its raw table and its history there, which are not for readers. Thus the catalog lists only views and their columns, as the catalog of elt-sqlite does.

## Considered Options

- **Postgres kinds with their own declarations,** such as a schema for the raw table and another for the view. A host would declare its derived data again for each destination.
- **The SQLite declarations, with the four differences met inside the kinds.** This option was selected.

## Consequences

- `publishPostgresViews` is no longer public: a host declares views as `View`.
- The refresh of a computed dataset is a second copy of the SQLite one. It moves to elt when a third destination keeps derived datasets (backlog #4649, ledger `copied-from-elt-sqlite.md`).
- A refresh is a load of the dataset in `_elt_loads`, which names a connector or a dataset, as in SQLite.

Sources: #3186.
