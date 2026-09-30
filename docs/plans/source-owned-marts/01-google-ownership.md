# Phase 01 — Google ownership and reader contract

Dependency: architecture selected in README; implement in a subsequent authorized session. Owner: Google publication modules and tests; shared reader contract changes only if selected architecture requires them.

## Read first

`apps/google/src/connectors.ts`, `apps/google/src/warehouse/search-console-marts.ts`, `apps/google/src/warehouse.test.ts`, `packages/destinations/postgresql/src/postgres-views.ts`, `infra/init/marts/contract.sql`, `packages/destinations/postgresql/src/postgres-sync-history-schema.ts`.

## Work

1. Move Search Console publication definitions beside `sources/search-console`; update imports directly. Preserve its source-specific measures and selection semantics.
2. Keep catalog/grants and pipeline sync metadata shared and source-neutral. Do not move them into Google or copy them for every source.
3. Replace stored global freshness and its schema-scanning refresh function with `search_console_freshness`, an ordinary view over explicit owned relations. Preserve observed `latest_date`, Google-only `latest_settled_date`, and max row `loaded_at`; empty relations return NULL. No global DELETE or refresh invocation.
4. Make URL path calculation Google-owned; inline it where small or use a source-prefixed helper. No broad helper registry. Publish only named Google relations in dependency order within a transaction.
5. Apply dependency readiness to Google too: a partial first load can leave raw tables absent. Publish only when the source bundle dependencies exist; preserve existing views, expose the specific publication gap, and retry on the next finite service run. Do not catch unrelated SQL failures as missing data. Test failed initial loads with absent targets, failed streams whose tables exist after sibling commits, partial committed loads and successful empty loads. Table presence never overrides extraction outcome. Finite publication failures reject with their cause; missing dependencies must leave failure exit status.
6. Remove obsolete current behavior from docs and skill references. Fresh rebuild is the remedy for old objects; no compatibility aliases or migration scripts. Update tests to current names.

## Checks and exit

Retain weighted position/CTR rules, authoritative totals, withheld-query calculations, latest-load filtering, trailing country windows and Pacific settled dates. Add a reader-facing ownership check with an independently owned relation: Google publication cannot modify its definition/comments/data. Prove freshness updates after raw changes without running publication again. Retain atomic replacement, raw/write denial and catalog description tests.

Run `nx run elt-postgresql:typecheck` and `nx run elt-postgresql:test` only if that project changes; run `nx run google:typecheck` and `nx run google:test`. Reuse scratch-warehouse and real reader-role patterns. Keep tests at `apps/google/src/*.test.ts`; preserve the skill’s explicit-invocation policy and update its freshness guidance to discover source-owned relations through catalog. Run an authorized finite Google load and read full published inventory, counts and date bounds as agent_reader. No Apple changes yet.

Exit: Google is independently published and correct; no Google code owns schema-wide freshness. Record exact file moves, names, checks and live results.

## Handoff record

Status: complete (2026-09-30). Changes: `apps/google/src/warehouse/search-console-marts.ts` moved to `apps/google/src/sources/search-console/search-console-marts.ts`; `marts.freshness`, `_refresh_freshness()`, `_url_path()` and the duplicate `mac-elt:marts` advisory lock removed (`publishPostgresViews` takes the same key); `search_console_freshness` is an ordinary view generated from the views that carry `loaded_at`; the URL path expression is inlined; publication first checks every Search Console raw table with `to_regclass` and rejects naming the missing ones. Google test helpers use `elt-postgresql/testing`.

Checks: `nx run elt-postgresql:test` (35 pass), `nx run google:test` (40 pass), `nx run elt-postgresql:typecheck`, `nx run google:typecheck`. New scenarios: freshness moves after a load with no re-publication; empty relations give NULL freshness; publication before any load names the missing tables and publishes nothing; a load whose page stream failed still publishes once the tables exist, with `stream_status` = failed; a view owned elsewhere keeps its definition and comment; catalog has no `table` kind.

Live evidence: warehouse reset with `nx run infra:reset`, then `nx run google:start` exited 0. As `agent_reader`: `sync_status` succeeded; 17 views, 0 undescribed catalog rows; `search_console_freshness` answered in 4 ms (latest 2026-09-29, settled 2026-09-27); 3,622 query rows, 1,530 page rows, totals 2025-07-20..2026-09-29.
