# Phase 07 — Whole-system acceptance and reader handoff

Dependencies: 03–06. Owner: cross-source verification, consumer skill/docs, completed phase evidence. No new feature scope.

## Work

1. Compare runtime `discover()` inventories, selected copy targets and readable catalog relations for Google and all six Apple sources. The source inventory is a baseline, not a permanent count. Every stream needs an explicit reader mapping; enumerate omissions and resolve them.
2. Query as agent_reader only for final consumer proof. Validate complete descriptions, actual types, row grain, join keys, null meanings, source limitations and attachment paths. Validate raw-schema/write/temp denial through synthetic integration tests.
3. Verify source publication independence in both orders, repeated startups, empty source tables, partial first-load readiness, subsequent retry, prior published view definitions after a failed replacement, extraction failures with possible partial committed raw changes, changes/deletes and clean cancellation. A failed pass does not guarantee raw contents stayed unchanged. Google publication must not modify Apple freshness or views.
4. Update query-warehouse to discover current content and relevant source-owned observed metadata through catalog. Keep it short, read-only and explicitly invoked. Do not add hardcoded stream lists to the consumer. Preserve Claude symlink.
5. Update README/reference with current architecture, source-specific example SQL and clear collection vs publication vs reading. No migration notes, guessed business meanings, or claims that sync completion proves service liveness/cloud completeness/publication success. State that reader-visible publication error history is outside this plan; availability comes from catalog and service diagnostics carry publication causes.

## Checks and live acceptance

Run Nx checks for every changed project; reuse prior passing checks if no related change requires another run. Core elt changes require dependent checks. Do not invoke typecheck merely to validate planning Markdown: it writes formatting changes.

Use the controlled live service check and stop criteria in phase 02 for any new executable; reuse Postgres but do not treat a pre-change watcher as proof. Live probe existing local warehouse with reader credentials: catalog inventory; per-source row counts and meaningful joins; latest completed pass/declared scope; source-specific dates and file availability. Inspect full relevant history, not a sample, where absence could mislead. A physical server or permission failure is an unavailable source, never an empty result. Reader probes cannot refresh, start services, change grants or switch credentials.

Service execution is a separate authorized implementation/live verification action. Reuse suitable processes, track PID/port/stop procedure for processes started, cancel and dispose them after verification; never kill an unowned watcher.

Exit: all phase gates complete, live reader can answer Notes/Messages/Contacts/Calendar/Reminders/Mail/Google questions using documented datasets, and the phase evidence states exact verified behavior and any genuine external blocker. Do not mark the whole plan complete with missing required content or verification.

## Handoff record

Status: complete (2026-09-30). Inventory: `apps/apple/src/warehouse.test.ts` builds every Apple connection exactly as the service does and requires all 103 `discover()` streams to validate as uniquely named, fully described views; the live catalog holds 120 views (103 Apple, 11 Search Console, `search_console_freshness`, `catalog`, 4 sync views) with 0 undescribed rows. No stream is excluded.

Checks (2026-09-30): `nx run elt:test` 22 pass, `nx run elt-postgresql:test` 35 pass, `nx run google:test` 40 pass, `nx run apple:test` 77 pass; `typecheck` (with lint) for elt, elt-postgresql, google and apple. Denials: raw schema reads are refused for google_search_console, apple_notes, apple_contacts and apple_messages in tests; writes and temp tables are refused (Google test). Independence: each Apple view is created with its own table and never replaced by a load; Google publication leaves a view it does not own unchanged; failed and empty first loads are covered in elt-postgresql, Google and Notes tests. query-warehouse needed no change: it already discovers relations and meanings through `marts.catalog` and names no dataset. README and docs/reference.md describe the current architecture (reader views, source-owned Search Console publication, `search_console_freshness`, `FileStorage.reference`, `elt-postgresql/testing`).

Live acceptance: warehouse reset; `nx run google:start` exit 0; `nx run apple:start` ran under this session's PID until all six connections finished a pass, then SIGTERM, clean exit 0 after the in-flight pass (~42 s). Final `sync_status`: all seven connections succeeded. No processes or scratch directories left behind.
