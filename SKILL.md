---
name: add-elt-source
description: Add or extend a data source in mac-elt. Use when implementing a new source, adding streams or fields, or changing extraction and sync behavior in the owning application.
---

# Add an ELT source

Stored data is disposable (see [AGENTS.md](AGENTS.md)): change schemas, identities and bindings freely; never add compatibility paths for existing output.

## Find the existing pattern

- Read [Source](packages/elt/src/core/source.ts), [Stream](packages/elt/src/core/stream.ts), [record validation](packages/elt/src/core/record-validation.ts) and [snapshot diffing](packages/elt/src/core/snapshot.ts).
- Pick the closest source:
  - [Apple Reminders](apps/apple/src/sources/apple-reminders/apple-reminders-source.ts): EventKit, one fetch per stream, snapshot incremental.
  - [Apple Calendar](apps/apple/src/sources/apple-calendar/apple-calendar-source.ts): bounded occurrence windows, paged per-item reads, related scalar streams, a feature-detected private API (ICS).
  - [Apple Notes](apps/apple/src/sources/apple-notes/apple-notes-source.ts): JXA scripting, staged attachment files.
  - [Google Search Console](apps/google/src/sources/search-console/search-console-source.ts): REST through [google-auth](packages/google-auth), a date cursor with restated facts (`dedupPolicy: 'replace'`), and polling `observe()`.

## Verify upstream behavior

- Inspect the public API and probe identities, relationships, nulls, dates, and failures before designing fields.
- Probe real behavior, not assumed fixtures: save temporary objects in the real app, read them back through the source, then delete them and confirm with a fresh read. Unsaved or hand-built objects only prove your projection code.
- Check what changes between two reads with no edits (export timestamps, generated IDs). Anything that varies per read breaks incremental diffs.
- Separate observations from assumptions, record live checks (date, OS version) in `docs/reference.md`, and report what the environment prevents verifying. Commit only synthetic fixtures.

## Implement extraction

Keep `packages/elt` platform-independent: contracts, pipeline, destinations, checkpoint storage, validation and diff helpers. Connectors live in their owning app (`apps/apple/src/sources/<source>/`, `apps/google/src/sources/<source>/`). A provider's authorization is shared by every connector for that provider, so it gets its own package (`packages/google-auth`). Import ELT contracts through `elt`, never library-internal paths.

- Declare streams in a `catalog`, at module level so instances share stream objects unless configuration changes the streams. Give the source a stable `identity` that distinguishes extraction configurations. The base `Source` provides `discover()` and rejects any stream that is not the catalog's own object in `validate()` and `watch()`; never re-implement that check.
- Put source-specific selection rules in `validateExtraction()`, without I/O. Implement lazy `extract(configuration, state)` yielding `{ stream, data }`, `DELETE` and `STATE` messages through the shared `Source.read()` path.
- Validate every record with `validateRecords(stream, records, '<Source>')` against the stream's schema (`type` with nullable unions, `enum`, `minimum`/`maximum`, `minLength`, `format: 'date-time' | 'date'`). Derive TypeScript record types with `SchemaRecord<typeof properties>`; never hand-write validators or duplicate types.
- Preserve missing values as `null`. Timestamps are canonical UTC (`isTimestamp`); local calendar dates stay dates (`isCalendarDate`).
- Compose the [EventKit class](apps/apple/src/platform/macos/eventkit.ts) for EventKit access and [OSA](apps/apple/src/platform/macos/osa.ts) for scripting. Native clients must not depend on `Source`, `Stream`, catalogs, schemas, or destinations.
- Preserve error causes. A failed read must throw, never become an empty collection, because an empty snapshot scan deletes every row.
- Detect a private or version-gated API before calling it, and fail with a typed error when it is missing.

## Choose the sync strategy

1. **The upstream has a change cursor** (a modification time or a date the API filters on): declare `incremental`, require the cursor in `validateExtraction()`, validate prior state, re-read equal cursors, and emit `STATE`. If the upstream restates facts under the same cursor, as Search Console revises recent days, copies use `dedupPolicy: 'replace'`.
2. **No change feed, but each read is a complete list**: declare `sourceDefinedCursor: true` and `emitsDeletes: true`, and in `extract` pass one complete scan to `diffSnapshot(stream, scan, state)`. The scan must yield each key once, so deduplicate overlapping reads first. Copies then select no `cursorField` and use `append_dedup` with the stream's own `primaryKey`. Unchanged records are not written and vanished keys are deleted.
3. **Neither**: full refresh only.

- Implement `observe({ streams, signal })` with the source's change trigger; the base `watch()` checks membership first. Subscribe before yielding all selected streams once, then emit affected streams. Honor cancellation and close native resources; do not load records or persist checkpoints in the watcher.
- Document deletion, snapshot and scan-cost limitations.
- Reuse `Copy`, `Pipeline`, and destinations; keep loading out of the source.
- Follow the staged-file contract and cleanup. Let `Source.read()` resolve requested bytes or parsed text.

## Integrate and verify

- Export the connector from its app's `src/index.ts`; keep `elt` exports generic. Add a minimal example and limitations to [README.md](README.md) and details to [docs/reference.md](docs/reference.md).
- Keep changes specific to the requested source; add shared machinery only for a demonstrated need.
- Add coverage to the app's `src/index.test.ts`, the only test file its target runs. Use controlled inputs and temporary pipeline storage, never personal data. Mock with `t.mock` and restore anything you re-mock in a loop, so no fake leaks into later tests.

Run from the workspace root, for every project you touched:

```sh
nx run <project>:typecheck
nx run <project>:test
```

If `packages/elt` changes, run every project's checks (`npx nx run-many -t typecheck` and `npx nx run-many -t test`).

Report implemented streams, checks run, live verification, and unverified behavior.
