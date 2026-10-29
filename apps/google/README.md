# google

The host of the Google sources. It loads Google Search Console and Google Health into the Postgres warehouse of [infra](../../infra/README.md) in one pass, and then stops.

```sh
npx nx run infra:up       # start the warehouse
npx nx run google:start   # build, then run src/main.ts
```

## What it does

`src/main.ts` is one entry, with no exports.

- It reads `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, the Desktop OAuth client of a project with `searchconsole.googleapis.com` and `health.googleapis.com` turned on.
- It opens the stored grants with `googleSession`, in `$XDG_CONFIG_HOME/elt`, or `~/.config/elt`. A grant that is missing opens a browser for consent.
- It runs one `Pipeline` with a `PostgresSyncHistory`, which installs the history and `marts.catalog` before the pass.
- The connection `google-search-console` reads a `SearchConsoleSource` for `sc-domain:ezz.sh`. It has one incremental `append_dedup` copy of each stream that `discover()` returns, with the id `search-console:<stream>`. Each copy loads `google_search_console.raw_<stream>` and keeps the reader view `marts.search_console_<snake_stream>`.
- The connection `google-health` reads a `GoogleHealthSource`. It has one `full_refresh` `overwrite` copy of each stream, with the id `health:<stream>`. Each copy loads `google_health.raw_<stream>` and keeps the reader view `marts.health_<snake_stream>`.
- Each connection keeps its checkpoints in its own schema, with `PostgresCheckpointStore`.
- The app catches no error. A missing variable, a refused grant or a `PipelineError` stops the app, and Node writes the error and exits with status 1.

The coverage of each source is in its `coverage(stream)`. See [Search Console](../../packages/sources/google/search-console/README.md) and [Google Health](../../packages/sources/google/health/README.md).
