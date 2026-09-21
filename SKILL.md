---
name: add-elt-source
description: Add or extend a data source in mac-elt. Use when implementing a new source, adding streams or fields, or changing extraction and sync behavior in the owning application.
---

# Add an ELT source

## Find the existing pattern

- Read [Source](packages/elt/src/core/source.ts) and [Stream](packages/elt/src/core/stream.ts).
- Use [Apple Reminders](apps/apple/src/sources/apple-reminders/apple-reminders-source.ts) for full refresh; [Apple Notes](apps/apple/src/sources/apple-notes/apple-notes-source.ts) for incremental state or files.
- Use [Apple Calendar](apps/apple/src/sources/apple-calendar/apple-calendar-source.ts) for EventKit access, bounded occurrence queries, and related scalar streams.

## Verify upstream behavior

- Inspect the public API and probe identities, relationships, nulls, dates, and failures before designing fields.
- Separate observations from assumptions. Report behavior the environment prevents verifying.

## Implement extraction

Keep `packages/elt` platform-independent: reusable contracts, pipeline, destinations, and checkpoint storage only. Apple connectors and native helpers belong under `apps/apple/src`; other integrations belong in their owning app. Work on Apple sources under `apps/apple/src/sources/<source>/`. Import ELT contracts through `elt`, never library-internal paths.

- Expose immutable streams, metadata-only `discover()`, and a stable source identity that distinguishes extraction configurations.
- Validate selections without I/O. Implement lazy `extract(configuration, state)`, yielding `{ stream, data }` through the shared `Source.read()` path.
- Validate records before yielding. Preserve missing values and distinguish timestamps from local calendar dates.
- Compose the [EventKit class](apps/apple/src/platform/macos/eventkit.ts) for EventKit access. The native client must not depend on `Source`, `Stream`, catalogs, schemas, or destinations. Keep projection and record validation in the connectors.
- Reuse [OSA](apps/apple/src/platform/macos/osa.ts) for scripting APIs. Preserve error causes; failed reads must not become empty collections.

## Handle sync and files

- Advertise only verified sync modes. Start with full refresh unless incremental behavior is required and proven.
- For incremental reads, validate prior state, handle replay and equal cursors, and emit source-owned `STATE` messages. Let the pipeline persist acknowledged state.
- Document deletion and snapshot limitations.
- Reuse `Copy`, `Pipeline`, and destinations; keep loading out of the source.
- Follow the staged-file contract and cleanup. Let `Source.read()` resolve requested bytes or parsed text.

## Integrate and verify

- Export Apple connectors through the [app index](apps/apple/src/index.ts); keep the `elt` package exports generic. Add a minimal example and limitations to [README.md](README.md).
- Keep changes specific to the requested source; add shared machinery only for a demonstrated need.
- Add focused coverage to [Apple app tests](apps/apple/src/index.test.ts), which the test target executes. Use controlled extraction inputs and temporary pipeline storage, without personal app data.

Run from the workspace root:

```sh
nx run apple:typecheck
nx run apple:test
```

If the generic ELT library changes, also run `nx run elt:typecheck` and `nx run elt:test`.

Report implemented streams, checks run, and unverified native behavior.
