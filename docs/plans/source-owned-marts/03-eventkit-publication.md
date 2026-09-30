# Phase 03 — Calendar and Reminders

Dependency: 02. Owner: Calendar/Reminders publication modules, their tests and explicit app registration entries. Shared EventKit fields stay native-client neutral.

## Work

Publish documented views for all 11 Calendar streams and all 8 Reminders streams listed in source-inventory.md. Read their source classes, `eventkit-schema.ts`, ICS records/script implementations, reminder date-component script and existing fixture tests.

Calendar events are occurrences. `eventId` is JSON `[calendarId,calendarItemId,occurrenceKey]`: NULL occurrenceKey for nonrecurring events, a local date for recurring all-day events, a UTC timestamp for recurring timed events. Preserve it; never replace it with nativeEventId or mutable startAt. Related EventKit rows join eventId. `icsComponents.eventId` is populated only for exact nonrecurring VEVENT masters; recurring series/components keep NULL and relate at `(calendarId,calendarItemId)` grain. Do not drop those components or multiply occurrence counts when joining them. Preserve the configured UTC overlap interval `[startAt,endAt)`, local all-day dates and series that extend beyond selected occurrences. Keep unavailable ICS attachment bytes distinguishable from absent metadata. Expose destination-managed attachmentRef with the index’s refs-only semantics; no new parsed content.

Reminders start/due date components remain component sets, with timezone/calendar/leap-month/missing-value meanings. Do not manufacture UTC due timestamps. Preserve list/account relationships, completion fields, priority and recurrence component joins. Document native numeric enums only when verified; preserve and label unknown codes.

Use phase 02 publication boundary and readiness policy. Author descriptions beside each source; share only truly identical proven field meanings. No unified event/task model or additional remote auth work.

## Checks and exit

Reader-facing synthetic cases: recurring/detached occurrence, all-day date, recurring ICS NULL eventId retained without multiplying occurrence counts, ICS series vs event joins, unavailable attachment; reminder with date-only and incomplete components, completed record, multiple alarms/rule values. Aggregation examples must not multiply owner counts. Verify empty sources publish and independent bundles leave Google/Notes unchanged.

Put integration tests in `apps/apple/src/*.test.ts` so Nx executes them. Preserve the index’s refs-only contract and reuse its controlled live-check procedure. Run `nx run apple:typecheck` and `nx run apple:test`. Live read all Calendar/Reminders view inventories, full available coverage and meaningful join/null examples. Widen rare-feature queries to the full selected history before calling them unverified; name native permission/API limitations precisely.

Exit: 19 stream views discoverable, described, semantically correct and wired through the service.

## Handoff record

Status: complete (2026-09-30). Changes: stream and field descriptions in `apps/apple/src/sources/eventkit-schema.ts` (`eventKitCatalog` now requires a description per stream; owner-specific related-field text), `apple-calendar/apple-calendar-source.ts`, `apple-reminders/apple-reminders-source.ts`. Enum meanings cite the macOS SDK EventKit headers; unknown codes stay numbers. Schema/type/key equivalence with HEAD was checked by compiled comparison with descriptions stripped.

Checks (2026-09-30): `nx run elt:test` 22 pass, `nx run elt-postgresql:test` 35 pass, `nx run google:test` 40 pass, `nx run apple:test` 77 pass; `typecheck` (with lint) for elt, elt-postgresql, google and apple. Reader tests (`index.test.ts`): 11 calendar views and 8 reminders views fully described; recurring occurrences keep distinct `eventId`s with their attendees; recurring ICS components keep NULL `eventId` and, aggregated per `(calendarId, calendarItemId)`, do not multiply occurrences; reminders keep date components as components (due date without time has NULL hour), completed reminder kept, list join holds.

Live evidence: apple-calendar and apple-reminders passes succeeded; 10,958 events, 70 reminders; 1,934 recurring VEVENT components with NULL `eventId`, 1,644 linked; 9 start and 44 due date component rows.
