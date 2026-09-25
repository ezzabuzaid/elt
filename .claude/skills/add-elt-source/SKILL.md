---
name: add-elt-source
description: Adds or extends a data source (connector) in mac-elt. Use when implementing a new source such as an Apple or Google app, adding streams or fields to an existing one, or changing how a source extracts, syncs, deletes, or watches for changes — even if the request only says "connector", "pull data from X", or "add X to the warehouse".
---

# Add an ELT source

Paths are relative to the repository root. The *upstream* is the system the data comes from (Messages, the Search Console API); the *app* is the Nx project that owns the source (`apps/apple`, `apps/google`).

Copy this checklist into your response and tick it off as you go:

```
- [ ] Probing: every access method and change signal listed, live checks run
- [ ] Source written, sync strategy picked from the list
- [ ] Black-box tests through src/index.ts
- [ ] README and docs/reference.md
- [ ] Gotchas checked against the diff
- [ ] Done when: e2e against the real upstream, backlog closed, report
```

## What you need to know

- Stored data is disposable (see `AGENTS.md`): change schemas, identities and bindings freely; never add compatibility paths for existing output.
- `packages/elt` is platform-independent: contracts, pipeline, the checkpoint protocol, validation and diff helpers. Import it as `elt`, never through internal paths.
- Each destination and its checkpoint store live in `packages/destinations/<name>` (`elt-sqlite`, `elt-markdown`, `elt-postgresql`).
- Sources live in their owning app: `apps/<app>/src/sources/<source>/<source>-source.ts`. A provider's authorization is shared by every source for that provider, so it has its own package (`packages/google-auth`).
- Native clients (`apps/apple/src/platform/macos/eventkit.ts` for EventKit, `osa.ts` for scripting) must not depend on `Source`, `Stream`, catalogs, schemas, or destinations. Compose them into the source.
- The contracts: `packages/elt/src/core/source.ts`, `stream.ts`, `record-validation.ts`, `snapshot.ts`.
- Pick the closest existing source by its traits:
  - **Apple Reminders**: EventKit, one fetch per stream, snapshot incremental.
  - **Apple Calendar**: bounded occurrence windows, paged per-item reads, related scalar streams, a feature-detected private API (ICS).
  - **Apple Notes**: the upstream's own Core Data SQLite store read-only; one template-method class per stream (`AppleNotesStream`) over a per-run scan that decodes protobuf note bodies and tables once; original-path attachment files; a `data_version` watch that keeps the app running hidden.
  - **Apple Messages**: the upstream's own SQLite database read-only, one read session per run, composite keys, original-path attachment files.
  - **Google Search Console** (`apps/google`): REST through `google-auth`, a date cursor with restated facts (`dedupPolicy: 'replace'`), polling `observe()`, quota-bound per-item refetch.

## Probing

- Before choosing an approach, list every way to read the data (public API, scripting dictionary, the upstream's on-disk database, private API) and every way to learn that it changed. Pick from the full list.
- Inspect the chosen API and probe identities, relationships, nulls, dates, and failures before designing fields.
- Probe real behavior, not assumed fixtures: create temporary objects upstream, read them back through the source, then delete them and confirm with a fresh read.
- Read twice with no edits in between and compare, to find per-read values.
- Separate observations from assumptions. Note each live check (date, OS version) for `docs/reference.md`, and name what the environment prevents verifying.

## Writing the source

### Shape

- Declare streams in a module-level `catalog` so instances share stream objects unless configuration changes the streams. Give the source a stable `identity` that distinguishes extraction configurations.
- One instance reading several properties or accounts: declare `partitionKey` on the streams, list partitions in `partitions(stream)` from configuration, and read the one `extract` receives. Put the partition fields in every record and every primary key.
- Every source implements `session(streams)`. Related streams (a join stream and its parents) return an `AsyncDisposable` that pins one consistent upstream view, such as a SQLite read transaction; independent streams return `new AsyncDisposableStack()`. `extract` receives it as its fourth argument. Hold nothing in it between runs.
- Put source-specific selection rules in `validateExtraction()`, without I/O. Implement a lazy `extract(configuration, state, partition, session)` yielding `{ stream, data }`, `DELETE` and `STATE` messages through the shared `Source.read()` path.

### Records

- Validate every record with `validateRecords(stream, records, '<Source>')` against the stream schema (`type` with nullable unions, `enum`, `minimum`/`maximum`, `minLength`, `format: 'date-time' | 'date'`). Derive record types with `SchemaRecord<typeof properties>`; never hand-write validators or duplicate types.
- Missing values stay `null`. Timestamps are canonical UTC (`isTimestamp`); local calendar dates stay dates (`isCalendarDate`).
- Preserve error causes.

### Sync strategy

Pick the first that fits:

1. **The upstream has a change cursor** (a modification time or a date the API filters on): declare `incremental`, require the cursor in `validateExtraction()`, validate prior state, re-read equal cursors, and emit `STATE`. If the upstream restates facts under the same cursor, copies use `dedupPolicy: 'replace'`.
2. **No change feed, but each read is a complete list**: declare `sourceDefinedCursor: true` and `emitsDeletes: true`, and pass one complete scan to `diffSnapshot(stream, scan, state)`. Copies select no `cursorField` and use `append_dedup` with the stream's own `primaryKey`. Unchanged records are not written; vanished keys are deleted.
3. **Each item must be refetched periodically under a quota**: incremental with `sourceDefinedCursor` and `emitsDeletes`; keep each item's last fetch time in state, fetch never-fetched then stalest items until the quota refuses, commit what succeeded, and delete items that left the set. `observe()` wakes the stream when the next item falls due; elt has no scheduler.
4. **Neither**: full refresh only.

### Watching

- Implement `observe({ streams, signal })` with the source's change trigger; the base `watch()` checks membership first. Subscribe before yielding all selected streams once, then emit affected streams. Honor cancellation and close native resources. Do not load records or persist checkpoints in the watcher.

### Files

- A yielded path stays readable until the consumer advances: a cleaned-up staged copy, or the original when copying would be costly.
- Let `Source.read()` resolve parsed text or a streamed `FileContent`; never read whole files into memory. A `DocumentParser` returns `null` for files without text and throws only on read failures.

### Loading

- Reuse `Copy`, `Pipeline`, and destinations; keep loading out of the source.

## Writing tests

Test the source the way a user runs it, as a black box. Do not write unit tests.

- Enter only through the app's public exports (`src/index.ts`), loaded by a real `Pipeline` into a real destination in temporary storage. Assert on what a consumer reads: rows or files, checkpoints, and what a second run writes.
- Control only the upstream, at its outermost seam: a synthetic copy of the upstream's database, the HTTP requester, or `osa`, which crosses into `osascript`. Never import or mock the source's own modules (scripts, parsers, decoders); they are covered through the streams that use them, by feeding bad input at the seam.
- Models: the Messages tests in `apps/apple/src/index.test.ts` (a synthetic `chat.db`, no mocks) and `apps/google/src/warehouse.test.ts` (a fake requester, scratch Postgres, read back through the agent role).
- Use controlled inputs, never personal data. Put tests in the app's top-level `src/*.test.ts`; the `test` target runs nothing in subfolders (apple runs `index.test.ts` alone).

## Writing docs

- Export the source from its app's `src/index.ts`; keep `elt` exports generic.
- `README.md`: a minimal example and limitations.
- `docs/reference.md`: details, the live checks from probing, and the deletion, snapshot and scan-cost limitations.
- Commit only synthetic fixtures.

## Gotchas

- **A failed read returns an empty list** → the snapshot diff sees every key vanish and deletes every row. Throw on failure; never turn an error into an empty collection.
- **A value changes between two reads with no edits** (export timestamps, generated IDs) → incremental diffs see unchanged records as changed. Find these while probing and drop or normalize them.
- **A scan yields the same key twice** (overlapping reads) → `diffSnapshot` breaks. Deduplicate before passing the scan.
- **Tests pass on hand-built objects** → only the projection code is proven. Upstream behavior is verified only by a live check.
- **You re-check that a stream belongs to the catalog** → duplicate logic; the base `Source` already rejects foreign streams in `validate()` and `watch()`.
- **A private or version-gated API is called without detection** → an opaque crash on other OS versions. Detect first and throw a typed error when it is missing.
- **A partition value ends up in the source `identity`** → the identity is part of the checkpoint binding and the target's writer (`packages/elt/src/core/copy.ts`), so adding one property rebinds every partition. Partition values belong in records and primary keys, not the identity.

## Done when

- Every stream the upstream exposes is extracted and every attachment kind it holds is handled. Nothing is silently capped, sampled, or windowed.
- A capability the source needed but `elt` lacked is added to `elt`, not worked around in the source. Finding those gaps is the point of each new source. Other changes stay specific to the requested source.
- Typecheck and tests pass for every touched project, and for every project if `packages/elt` changed, because every destination and app depends on it.
- The source works end to end against the real upstream, not only against the controlled upstream the tests use. Run the entry point a user runs (`nx run <app>:start`, or the source's own target such as `apple:messages`) into a real destination, then inspect the actual output: tables or files, checkpoints, and a second run with no upstream changes that behaves as the sync strategy promises (a snapshot stream writes nothing).
- Live checks are run, not deferred. Behavior counts as unverified only when the environment cannot produce it, and a backlog item does not replace the check.
- Every agent-backlog item opened during the work, and every open item related to the source, is closed.
- Each gotcha above is checked against the diff.
- The final report lists implemented streams, checks run, live checks, and anything unverified along with what blocked it.
