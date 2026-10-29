# The history install publishes the catalog

Since elt 9478748e, the pipeline installs its sync history before each run and watch. The Postgres side was half done: `install()` published the history views in `marts`, but not the catalog. Thus `apps/google` and `apps/proactive` still called `history.install()` and `installPostgresCatalog({ url, schema: 'marts' })` themselves, and each test that used Postgres installed the history by hand.

Thus `install()` publishes `catalog` in `marts` beside `sync_attempts`, `extraction_coverage`, `sync_status` and `stream_status`, in the same transaction and the same call of `publishPostgresViews`. The two hosts named only `marts`, so the catalog lists `marts` and nothing else.

## Considered Options

- **Each host installs the catalog.** Hosts keep an order that the pipeline already keeps.
- **The install of the history publishes the catalog.** This option was selected.

## Consequences

- `installPostgresCatalog` and its export are gone.
- No host and no test installs the history or the catalog by hand.

Sources: elt 2328ef1d, 9478748e.
