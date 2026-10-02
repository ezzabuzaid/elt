# Plan verification — 2026-09-29

Rechecked against HEAD `7514de0` with three independent reviews: publication/lifecycle, native source contracts, and history/scope. This verifies the plan’s grounding and handoff completeness, not implementation correctness. Production code and runtime state were not changed; Nx tests and live service runs were not executed in this planning review.

## Phase-by-phase result

| Phase              | Grounding checked                                                                                                       | Correction or confirmed requirement                                                                                                                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01 Google          | `connectors.ts`, existing marts definitions, `publishPostgresViews`, grants/catalog, Google warehouse tests             | Keep source-owned ordinary freshness and metrics; test absent dependencies AND failed streams with durable tables. Finite publication errors reject. Update consumer guidance in this phase when freshness names change.                                            |
| 02 Notes/lifecycle | Apple app wiring, Pipeline pass/yield flow, replication prepare/commit, Postgres shared load transaction, LocalFiles    | Select concrete service error handling separate from extraction history. Verify partial committed data and failed replacement rollback separately. Controlled current-binary live run with explicit stop criteria; no fixed-sleep success. Keep refs-only exporter. |
| 03 EventKit        | Calendar event identity/script, ICS record construction, Reminders date components                                      | Exact occurrence identity and nullable recurring ICS eventId are recorded. Retain date component sets and avoid count-multiplying series joins.                                                                                                                     |
| 04 Contacts        | Source stream definitions and existing synthetic Contacts fixture                                                       | Distinguish native inline/external image storage from destination attachmentRef; adapt source fixture to exporter’s Postgres file projection.                                                                                                                       |
| 05 Messages        | Source stream definitions and composite handle relationships                                                            | Use messages.handle/handleService and otherHandle/otherHandleService; chatHandles uses handleId/handleService. Keep same-address/different-service test.                                                                                                            |
| 06 Mail            | 29 index definitions + 13 supplemental stream definitions, MIME and configuration keys, existing file-reference fixture | Exact total 42; specify MIME parent and scoped rule joins. Add index/supplemental sub-session checkpoints while retaining full phase gate. No parser expansion.                                                                                                     |
| 07 Acceptance      | Source inventories, reader init contract, skill invocation policy, Nx project targets                                   | Require complete source-to-reader mapping, publication independence, truthful extraction/publication distinction, full-history live checks and owned-process cleanup.                                                                                               |

## Important decisions now pinned

- User-selected shared `marts` with source-owned publication. No new reader schemas or registry.
- Whole-source readiness requires SQL dependencies to exist; it never establishes stream success. A sibling commit can persist a failed stream’s empty target. The reader must check copy outcomes before interpreting an empty view.
- Existing sync history records extraction before publication; it must not be relabeled to report publication failure. Service diagnostics carry publication causes. Reader-visible publication error history is explicitly outside this plan.
- Ordinary source-owned freshness reads committed rows without a separate refresh job. Apple does not inherit Google’s settled-day meaning.
- Managed attachment references and already collected native text remain the current contract. Exact synthetic bytes can be checked by reading the path; new parser/binary-column work is excluded.
- Apple startup still requests Calendar attachment OAuth before constructing its pipeline. Publication independence applies after app setup; authentication isolation is not claimed.
- Tests belong in `apps/<app>/src/*.test.ts`; current Nx globs skip nested source-folder tests.
- Large phases can checkpoint across sessions. Only complete phase exit criteria advance the tracker.

## Source inventory verification

Notes 5 + Calendar 11 + Reminders 8 + Contacts 24 + Messages 13 + Mail 42 = **103** Apple streams, verified from current source definitions. This is not a count of loaded records or live reader relations. Preserve runtime inventory comparisons in phase 07 because source catalogs can change before implementation.

## Checks on planning artifacts

All phase files and supporting history/inventory were read. Relative document links, Markdown fences, trailing whitespace and phase dependency references are checked before delivery. No staging or commits. Every phase stays planned; its implementation checks and live evidence are pending.
