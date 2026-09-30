# Phase 06 — Mail

Dependency: 02. Owner: Mail publication module, integration tests and registration entry. Re-read current Mail schema because another session changed it during planning.

## Work

Read `mail-tables.ts`, `apple-mail-source.ts`, Mail scan/store/MIME implementation and current Mail fixtures. Use the exact corrected inventory in source-inventory.md; verify `discover()` against definitions before starting. Publish every current Mail stream, including index tables, configuration metadata, headers, MIME parts and file streams.

Document local index identities and subject/summary/address references, message/mailbox membership and server variants. MIME parts use `(messageId,partId)`; parent joins are `(messageId,parentPartId) → messageParts(messageId,partId)`. Headers additionally key on position and preserve raw lines. Rule conditions join `(scope,ownerId) → rules(scope,id)`; smart mailbox conditions retain their own owner/scope rules. Index attachment metadata can exist before message files download. Keep unavailable/partial files explicit and preserve file references; do not promise full message bodies where only metadata exists.

Unverified date numbers keep their Raw fields and unknown meanings; do not guess epochs. Property JSON for rules/configuration remains data. Preserve the refs-only exporter. No parser rewrite, parser wiring, binary database columns or new extracted attachment text. Native messageParts.text and source summaries remain published as already collected fields.

## Sub-session checkpoints

06a: publish and verify all 29 index/table-backed streams; record exact source-to-reader mapping and remaining fields, joins and tests. Keep the whole-source dependency readiness rule.

06b: publish and verify all 13 supplemental streams, including scoped configuration and MIME/file records; complete the all-42 mapping and combined reader tests/live evidence. A checkpoint is not completion. Retain one source-owned module or split files by these native concerns only if size needs it; no new registry.

## Checks and exit

Reader-facing synthetic Mail fixture: multiple recipients/mailboxes, subject/summary/address joins, nested MIME parts, repeated ordered headers, index-only attachment, missing and partial file, scoped rule conditions and raw unknown date. Prove message counts at message grain. Check every view/column description and that publication does not modify any other source.

Put integration tests in `apps/apple/src/*.test.ts` so Nx executes them. Preserve the index’s refs-only contract and reuse its controlled live-check procedure. Run `nx run apple:typecheck` and `nx run apple:test`. Live verify the existing Mail attempt and all available views. An unfinished extraction is not empty Mail; wait/reuse service or record the precise blocker. Exhaust full available history for attachment kinds before reporting them unverified.

Exit: every discovered Mail stream is published with verified identities, cardinality and availability meanings.

## Handoff record

Status: complete (2026-09-30); 06a and 06b done together. Changes: `apps/apple/src/sources/apple-mail/mail-tables.ts` (every table call now takes a stream description and proven column meanings; provenance generated from Envelope Index table, column and kind, with `Raw` date numbers labeled unconverted) and `apple-mail-source.ts` (13 supplemental streams; `described()` makes a missing field description a compile error). All 42 streams, 237 fields. Claims resting only on the live-probe notes in docs/reference.md (Message-ID hash, mailbox URL host = account id for scripted accounts) are worded as such. Equivalence with HEAD checked by comparing `discover()` with descriptions stripped.

Checks (2026-09-30): `nx run elt:test` 22 pass, `nx run elt-postgresql:test` 35 pass, `nx run google:test` 40 pass, `nx run apple:test` 77 pass; `typecheck` (with lint) for elt, elt-postgresql, google and apple. Reader test (`mail.test.ts`): 42 views fully described; subject join and recipients at message grain; every MIME child finds its parent on `(messageId, parentPartId)`; ordered repeated headers; every rule condition finds `(scope, id)`; `Raw` date left as its number; exact bytes for a downloaded attachment, NULL references for index-only and missing ones; message file availability explicit.

Live evidence: apple-mail first pass succeeded (and two later watch passes). 25,723 messages, all with a subject; 69,418 MIME parts, 43,695 with a parent and all parents found; 23 rule conditions, all matched; 1,152 attachments, 576 exported and 576 explicitly unavailable; no missing message files. Reader queries answered in milliseconds while a Mail load transaction was open.
