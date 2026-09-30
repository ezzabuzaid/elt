# Phase 04 — Contacts

Dependency: 02. Owner: Contacts publication module, integration tests and its registration entry.

## Work

Read `contacts-streams.ts`, `apple-contacts-source.ts`, contacts scan/store modules and current synthetic fixture tests. Publish documented views for all 24 streams. Preserve source-local contact/container/group IDs, labeled multi-value rows, nested group links, address selection configuration, unknown properties and managed exported image references. `images.storage` (`inline` or `external`) describes the native source; `externalId` is the source storage identifier. Both byte sources export via destination-managed attachmentRef.

Birthday year 1604 is a native unknown-year sentinel already mapped to NULL; do not turn it into a real birth year. Keep alternate-calendar components distinct. Preserve nullable booleans. Images use `(contactId,kind)`; metadata or an image row is not proof that bytes are readable. Describe every field with verified meaning or explicitly unknown native meaning; do not infer semantics from a name.

No cross-source person matching or merged contact table. Use phase 02 readiness and publication boundary.

## Checks and exit

Synthetic fixture → Postgres → agent_reader: one contact with multiple phones/emails/groups, nested membership, unknown birth year, alternate birthday and two image kinds. Adapt the Contacts fixture’s source to the exporter’s Postgres `.file.store(LocalFiles)` projection; its existing SQLite blob output is not evidence that the reader contract stores bytes. Read exported references back for exact synthetic-byte equality. Prove owner counts survive one-to-many joins; no fabricated values. Check full view/column descriptions and raw denial.

Put integration tests in `apps/apple/src/*.test.ts` so Nx executes them. Preserve the index’s refs-only contract and reuse its controlled live-check procedure. Run `nx run apple:typecheck` and `nx run apple:test`. Live verify all Contacts views and available records through the reader, compare declared local coverage and observed counts without claiming cloud completeness.

Exit: all 24 stream views are queryable, with native relationships preserved.

## Handoff record

Status: complete (2026-09-30). Changes: `apps/apple/src/sources/apple-contacts/contacts-streams.ts` — hand-written stream descriptions (grain, key, joins, local-store limits) and a provenance generator next to `kinds` (AddressBook table.column plus the conversion applied), with proven meanings overriding it (keys, joins, 1604 unknown-year sentinel as NULL, alternate calendars, image storage vs exported file). Equivalence with HEAD checked with descriptions stripped.

Checks (2026-09-30): `nx run elt:test` 22 pass, `nx run elt-postgresql:test` 35 pass, `nx run google:test` 40 pass, `nx run apple:test` 77 pass; `typecheck` (with lint) for elt, elt-postgresql, google and apple. Reader test (`contacts.test.ts`): 24 views fully described; per-contact phone and group counts survive the joins (aggregated first); unknown birth year NULL; alternate Chinese-calendar birthday; nested smart group; image storage kinds; exact bytes through `attachmentRef`; raw denial.

Live evidence: apple-contacts pass succeeded; 414 contacts; 29 images, all exported. No live unknown-year birthday exists (0 over the full store); the fixture covers it.
