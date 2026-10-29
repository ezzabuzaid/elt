# The pipeline installs its sync history before each run and watch

Hosts called `history.install` and the install of the catalog by hand, in an order that only their own code kept. The web app of elt never installed the catalog that its readers use to find views (context-compiler #2618).

Thus `SyncHistory.install(connections)` is abstract on the port. The pipeline calls it after `validate` and before a read, on each run and watch, as the destinations of Airbyte set up their tables before the first record. It is safe to repeat. `SQLiteSyncHistory.install` also publishes the catalog in each file. `PostgresSyncHistory.install` publishes `marts.catalog` beside the history views (elt 2328ef1d).

A host that knows that no other process runs a pass of its connections makes `new SQLiteSyncHistory({ soleWriter: true })`. Its install records as failed each pass that started and never ended, as Airbyte fails the unfinished jobs of a connection before it starts the next.

## Considered Options

- **Each host installs the history and the catalog.** A host can forget a step, as the web app did.
- **The pipeline installs the history before each run and watch.** This option was selected.

## Consequences

- No host installs the history or the catalog.
- Each run installs again, so the history declares its views. A view whose stored definition agrees stays as it is, so a run that changes nothing keeps the schema.

Sources: elt 9478748e, 2328ef1d; context-compiler backlog #2618.
