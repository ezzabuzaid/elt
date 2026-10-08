---
name: add-elt-source
description: Adds or extends a data source and its connector in context-compiler. Use when implementing a new source such as an Apple or Google app, adding streams or fields to an existing one, or changing how a source extracts, syncs, deletes, or watches for changes — even if the request only says "connector", "pull data from X", or "add X to the warehouse".
---

# Add an ELT source

Paths are relative to the repository root. The _upstream_ is the system the data comes from (Messages, the Search Console API); the _source package_ is the Nx project that holds the source; the _connector_ is a host's use of it: for the Apple hosts, a connector package `packages/connectors/apple/<name>` both of them load; for Google, an entry in `apps/google`.

Copy this checklist into your response and tick it off as you go:

```
- [ ] Probing: every access method and change signal listed, live checks run
- [ ] SDK written or reused: the store's location, read-only open, decoding, errors and change signal
- [ ] Source written, sync strategy picked from the list
- [ ] Black-box tests through source classes and real destinations
- [ ] README and docs/reference.md
- [ ] Gotchas checked against the diff
- [ ] Done when: e2e against the real upstream, backlog closed, report
```

## What you need to know

- Stored data is disposable (see `AGENTS.md`): change schemas, identities and bindings freely; never add compatibility paths for existing output.
- `packages/elt` is platform-independent: contracts, pipeline, the checkpoint protocol, validation and diff helpers. Import it as `elt`, never through internal paths.
- Each destination and its checkpoint store live in `packages/destinations/<name>` (`elt-sqlite`, `elt-markdown`, `elt-postgresql`).
- Each source is its own package, written as if published to npm: `packages/sources/<platform>/<name>`, the source class in `src/` (`apple-notes-source.ts`, `search-console-source.ts`), project and package `source-<platform>-<name>` (`@workspace/source-apple-notes`), tagged `layer:island` (see `AGENTS.md`, "Agnostic packages"). Copy `packages/sources/apple/notes` for its `package.json` (explicit `exports`), `project.json` and `tsconfig.json`, and add the folder to nothing else: the root workspaces already cover `packages/sources/*/*`. Start from the store's SDK (see `AGENTS.md`, "SDKs"): the store or API a source reads is its own package in `packages/sdks/<platform>/<surface>` (`sdk-<platform>-<name>`, tagged `layer:island` and `layer:sdk`) that owns its location, read-only open, decoding, key meanings, access errors and change signal, and holds no source logic. Write it first, or reuse it when another source already reads the store (`packages/sdks/apple/accounts`, `@workspace/sdk-apple-accounts`, for Mail). Each source maps an SDK into its own streams, schemas and rows, even when two sources map it alike. Only pipeline helpers several sources of a platform share go in that platform's shared island (`source-apple-macos`); store readers never do. A connector is a host's use of a source: its titles, choices, permission guidance and settings wiring live in its connector package, never in the source package. A provider's authorization is shared by every source for that provider, so it has its own package (`packages/google-auth`).
- Register an Apple source as a connector package `packages/connectors/apple/<name>` (`connector-apple-<name>`, not an island, since `AppleConnector` writes to the import store): `src/<name>-connector.ts`, whose default export is the `AppleConnector` subclass and which imports its source from the source package, and a `package.json` that is its manifest: `"exports": "./dist/<name>-connector.js"` and a `contextCompiler` field with the connector's `name` and `title`, which the class does not declare. Copy `packages/connectors/apple/notes`, and add the package to the dependencies of `apps/apple/cli` and `apps/apple/plugin`, so Nx builds it before them. Both hosts discover it through `Connectors` in `packages/connectors/apple/manifest`; the plugin bundle ships it as its own connector folder. A connector outside the repository goes in `~/Library/Application Support/Context Compiler/Connectors/<name>/` with a `package.json` whose `exports` is `./<name>-connector.ts`, the entry written as strip-only TypeScript that imports only Node built-ins and the host modules in `packages/connectors/apple/manifest/src/host-modules.ts` (model: `packages/connectors/apple/manifest/src/fixtures/photos`). Each import loads `raw_<stream>` tables into its own `data.sqlite`, read through `<snake_stream>` views. Register a Google connector as a `{ name, run }` entry in `apps/google/src/connectors.ts`, keeping credentials, pipeline setup/execution and post-load work inside `run()`; its `main.ts` runs the list in a plain loop that sets exit status 1 on failure and continues without console output. Do not add a shared runner package, result protocol, or lifecycle hooks.
- SDKs (`CalendarStore` and `RemindersStore` in `packages/sdks/apple/eventkit`, which run the Swift `eventkit` helper; `AccountsStore` in `packages/sdks/apple/accounts`) never depend on `Source`, `Stream`, catalogs, schemas or destinations; lint rejects it. Compose them into the source.
- The contracts: `packages/elt/src/core/source.ts`, `stream.ts`, `record-validation.ts`, `snapshot.ts`.
- Pick the closest existing source by its traits:
  - **Apple Reminders**: EventKit through a native helper, one read for every selected stream, snapshot incremental.
  - **Apple Calendar**: bounded occurrence windows read in one helper process, related scalar streams, feature-detected private APIs (ICS, calendar descriptions).
  - **Apple Notes**: the upstream's own Core Data SQLite store read-only; one template-method class per stream (`AppleNotesStream`) over a per-run scan that decodes protobuf note bodies and tables once; original-path attachment files; a `data_version` watch that keeps the app running hidden.
  - **Apple Messages**: the upstream's own SQLite database read-only, one read context per run, composite keys, original-path attachment files.
  - **Apple Safari**: several stores behind one source, SQLite databases and property lists; `open` reads only the stores the selected streams need, and a store that cannot be opened fails only its streams; per-profile databases listed by another store; array fields for lists of values.
  - **Apple Books**: several Core Data stores in two containers plus preference files; a Coherence CRDT document decoded with `codec-protobuf`; files in iCloud Drive whose placeholders must never be opened (BSD flags via `/usr/bin/stat`); a package directory staged as one file per record.
  - **Apple Activity**: an upstream that drops records after a fixed age without a deletion (Biome segment files, knowledgeC), so streams declare `expiresBy` and pass the age as a horizon; a private binary format read by its own codec (`packages/codecs/segb`) beneath the store's SDK (`sdk-apple-biome`); records addressed by their place in a file; one snapshot group per segment fingerprinted by its trailer, since the files never change size or modification time; a stream base per store that owns its diff.
  - **Apple Call History**: a Core Data store another daemon fills from the user's other devices through iCloud (callhistoryd); the meaning of each column and code taken from the app's own Core Data model (`CallHistory 46.mom` in the framework); per-call copies of related rows (handles), so the related entity is folded into its parent and a join stream rather than keyed by Core Data's row number; a numbered join table found by its name's end; every column checked once when the snapshot opens; an import date range that keeps the records of the selected parents.
  - **Apple Notification Center**: a store that keeps each notification only until its app withdraws it or the user clears it, and records neither, so its notifications stream declares no `emitsDeletes` and keeps every row it loaded while the streams describing the store now (apps, categories) delete; a binary property list per row with four-letter keys, named from the daemon's own strings and Apple's public API, every key also kept as JSON (`payload`) with nested NSKeyedArchiver archives decoded where they sit; a row number the daemon reuses, so the key is the delivery's UUID; a list an app registers whole and may repeat identifiers in, keyed by position.
  - **Google Search Console** (`packages/sources/google/search-console`): REST through `google-auth`, a date cursor with restated facts (`dedupPolicy: 'replace'`), polling `observe()`, quota-bound per-item refetch.
  - **SQL Server** (`packages/sources/microsoft/sql-server` over `sdk-microsoft-sql-server`): streams discovered from the upstream's own tables (`await SqlServerSource.discover(database)`, rediscovered each run); one stream class per sync strategy, picked at discovery from what the login can read (Change Tracking, else rowversion, else full refresh); a resumable first load paged by the whole primary key; values read as the text the server spells exactly, with sibling fields where one column holds two facts (`<column>_offset`, `<column>_type`); tests against a compose server (`infra:up-sqlserver`) with a scratch database and read-only login per test.

## Probing

- Before choosing an approach, list every way to read the data (public API, scripting dictionary, the upstream's on-disk database, private API) and every way to learn that it changed. Pick from the full list.
- Inspect the chosen API and probe identities, relationships, nulls, dates, and failures before designing fields.
- Probe real behavior, not assumed fixtures: create temporary objects upstream, read them back through the source, then delete them and confirm with a fresh read.
- Read twice with no edits in between and compare, to find per-read values.
- Separate observations from assumptions. Note each live check (date, OS version) for `docs/reference.md`, and name what the environment prevents verifying.

## Writing the source

### Shape

- Declare streams in a module-level `catalog` so instances share stream objects unless configuration changes the streams. When the streams come from the upstream itself, such as a database's tables, discover them in an async static factory (`await XSource.discover(connection)` returns `new XSource(connection, catalog)`), and have the host build a new source each run: a changed table then reaches the pipeline as a changed stream, which starts its copies over. Give the source a stable `identity` that distinguishes extraction configurations.
- One instance reading several properties or accounts: declare `partitionKey` on the streams, list partitions in `partitions(stream)` from configuration, and read the one `extract` receives. Put the partition fields in every record and every primary key.
- Every source implements `protected open(streams)`: one run is one `Source.read` over every selected stream, and `open` returns the `AsyncDisposable` context it reads through. Related streams (a join stream and its parents) pin one consistent upstream view, such as a SQLite read transaction; independent streams return `new AsyncDisposableStack()`. `extract` receives it as its fourth argument. Hold nothing in it between runs. Raise `protected concurrency` only when several extracts can share the context at once.
- Put source-specific selection rules in `validateExtraction()`, without I/O. Implement a lazy `extract(configuration, state, partition, context)` yielding `{ stream, data }`, `DELETE`, `RESET` and `STATE` messages through the shared `Source.read()` path. Each `STATE` is a commit point: the destination commits every row before it and the checkpoint is saved, so emit one only when everything before it is final. A read that fails must throw; the engine reports that partition, keeps its checkpoint, and goes on with the others. `extract` receives the run's `signal` as its last argument: pass it to anything that waits on the upstream, so a cancelled run stops at once.

### Records

- Validate every record with `validateRecords(stream, records, '<Source>')` against the stream schema (`type` with nullable unions, `enum`, `minimum`/`maximum`, `minLength`, the string formats in `docs/reference.md` (String formats: `date-time`, `date-time-local` and `time-local` with a `precision`, `date`, `int64`, `decimal` with `precision` and `scale`, and `contentEncoding: 'base64'`) for values a JSON number or a JavaScript `Date` would round, and `type: 'array'` with an `items` schema for a list of values; a collection whose members have fields is its own stream). Derive record types with `SchemaRecord<typeof properties>`; never hand-write validators or duplicate types.
- Missing values stay `null`. Timestamps are canonical UTC (`isTimestamp`); local calendar dates stay dates (`isCalendarDate`).
- Preserve error causes.
- Do not add console logging or output, including debug tables and consent-link printing. Preserve errors and exit statuses; examples should follow the same rule.

### Sync strategy

Pick the first that fits:

1. **The upstream has a change feed** that reports changed and deleted keys since a version (SQL Server Change Tracking or CDC): declare `sourceDefinedCursor: true` and `emitsDeletes: true`, keep the feed's version as state, read the changes since it, emit their records and `DELETE`s, then `STATE` with the new version. When the saved position is one the feed no longer covers (older than it keeps, ahead of it, or from before a truncate), emit `RESET` and reload every row, emitting `STATE` after each page as a first load does: the reload goes to a hidden target that replaces the stream's rows when it ends, so readers keep the old rows meanwhile and a reload that fails resumes. Check the feed's own docs against the live server: SQL Server's minimum valid version misses a truncate right after a sync, which only the table's tracking generation shows.
2. **The upstream has a change cursor** (a modification time or a date the API filters on): declare `incremental`, require the cursor in `validateExtraction()`, validate prior state, re-read equal cursors, and emit `STATE`. If the upstream restates facts under the same cursor, copies use `dedupPolicy: 'replace'`.
3. **No change feed or cursor, but each read is a complete list**: declare `sourceDefinedCursor: true` and `emitsDeletes: true`, and pass one complete scan to `diffSnapshot(stream, scan, state)`. Copies select no `cursorField` and use `append_dedup` with the stream's own `primaryKey`. Unchanged records are not written; vanished keys are deleted. When records come from inputs whose stat or version identifies their content (files, messages), group them with `diffGroupedSnapshot(stream, groups, state)`: still list every input, but read only those whose fingerprint changed. Put a parser-version constant in the fingerprint. When the upstream drops records past an age without deleting them, declare `expiresBy` on the stream and pass each diff the horizon the upstream keeps records from, taken from its retention rule, never from the oldest record found. When the upstream drops records for reasons it does not record, so no removal can be told from a deletion (Notification Center: an app withdrew it, the user cleared it, a newer one replaced it), leave `emitsDeletes` out: the diff then never deletes, and every row it loaded stays.
4. **Each item must be refetched periodically under a quota**: incremental with `sourceDefinedCursor` and `emitsDeletes`; keep each item's last fetch time in state, fetch never-fetched then stalest items until the quota refuses, commit what succeeded, and delete items that left the set. `observe()` wakes the stream when the next item falls due; elt has no scheduler.
5. **None of these**: full refresh only.

### Watching

- Implement `observe({ streams, signal })` with the source's change trigger; the base `watch()` checks membership first. Subscribe before yielding all selected streams once, then emit affected streams. Honor cancellation and close native resources. Do not load records or persist checkpoints in the watcher.

### Files

- A yielded path stays readable until the consumer advances: a cleaned-up staged copy, or the original when copying would be costly.
- Let `Source.read()` resolve parsed text or a streamed `FileContent`; never read whole files into memory. A `DocumentParser` returns `null` for files without text and throws only on read failures.

### Loading

- Reuse `Copy`, `Pipeline`, and destinations; keep loading out of the source.

## Writing tests

Test the source the way a user runs it, as a black box. Do not write unit tests.

- Import source classes directly from their defining modules and load them through a real `Pipeline` into a real destination in temporary storage. Assert on what a consumer reads: rows or files, checkpoints, and what a second run writes.
- Control only the upstream, at its outermost seam: a synthetic copy of the upstream's database, the HTTP requester, `nativeProcess.lines`, which yields the `eventkit` helper's stdout lines, or `osa`, which crosses into `osascript`. Never import or mock the source's own modules (scripts, parsers, decoders); they are covered through the streams that use them, by feeding bad input at the seam.
- Models: the Messages tests in `packages/sources/apple/messages/src/messages-source.test.ts` (a synthetic `chat.db`, no mocks) and `packages/sources/google/search-console/src/warehouse.test.ts` (a fake requester, scratch Postgres, read back through the agent role).
- Use controlled inputs, never personal data, except one live read-only test per native store that asserts shapes and counts, persists nothing outside a temporary directory, and skips without access (the Calendar and Reminders helper test). Put tests in the source package's top-level `src/*.test.ts`; the `test` target runs nothing in subfolders. Split a test that covers two sources (Calendar and Reminders) into one test per source package.

## Writing docs

- Apps are executables, not libraries: use direct imports in their entry points, tests, and examples; do not add app export barrels. `apps/` holds no libraries: what the Apple hosts share lives in `packages/connectors/apple`, `connector-apple-connector` (`AppleConnector`) and `connector-apple-manifest` (discovery and the host modules) beside one package per connector. A source or connector package exports each public module as an explicit subpath (`@workspace/source-apple-mail/apple-mail-source`, `@workspace/connector-apple-connector/apple-connector`), never a barrel; a connector package's `exports` string names only its entry. Keep other reusable package exports in `packages/` and `elt` exports generic. A default-exported connector registration list is app configuration, not a public module barrel.
- `README.md`: a minimal example and limitations.
- `docs/reference.md`: details, the live checks from probing, and the deletion, snapshot and scan-cost limitations.
- Commit only synthetic fixtures.

## Gotchas

- **A store's columns are checked per table, on each read** → `AppDatabase.requireColumns` closes the shared snapshot on a miss, so every stream after the first fails with a bare `database is not open`. Check every column the SDK reads once, when the snapshot opens, as the Notes, Messages, Safari and Call History SDKs do; or, when the store's readers use different tables, check each read with `missingColumns`, which keeps the snapshot open, as Accounts does so Mail is not blocked by tables it does not read.
- **A failed read returns an empty list** → the snapshot diff sees every key vanish and deletes every row. Throw on failure; never turn an error into an empty collection.
- **A value changes between two reads with no edits** (export timestamps, generated IDs) → incremental diffs see unchanged records as changed. Find these while probing and drop or normalize them.
- **A scan yields the same key twice** (overlapping reads) → `diffSnapshot` breaks. Deduplicate before passing the scan.
- **A value goes through a JSON number or a `Date`** (a 64-bit id past 2^53, a decimal or money amount, a time finer than milliseconds) → it loads rounded and nothing reports it. Read it as text from the upstream and declare its string format.
- **Tests pass on hand-built objects** → only the projection code is proven. Upstream behavior is verified only by a live check.
- **You re-check that a stream belongs to the catalog** → duplicate logic; the base `Source` already rejects foreign streams in `validate()` and `watch()`.
- **A private or version-gated API is called without detection** → an opaque crash on other OS versions. Detect first and throw a typed error when it is missing.
- **`MacOSDocumentParser` image tests exit with SIGSEGV** (`sysctlbyname for kern.hv_vmm_present failed`) → the agent's command sandbox blocks a call that Vision needs; macOS is not at fault. Run `source-apple-messages:test` and `source-apple-mail:test` outside the sandbox before you treat an OCR crash as a defect.
- **A partition value ends up in the source `identity`** → the identity is part of the checkpoint binding and the target's writer (`packages/elt/src/core/copy.ts`), so adding one property rebinds every partition. Partition values belong in records and primary keys, not the identity.

## Done when

- Every stream the upstream exposes is extracted and every attachment kind it holds is handled. Nothing is silently capped, sampled, or windowed.
- A capability the source needed but `elt` lacked is added to `elt`, not worked around in the source. Finding those gaps is the point of each new source. Other changes stay specific to the requested source.
- Typecheck and tests pass for every touched project, and for every project if `packages/elt` changed, because every destination and app depends on it.
- The source works end to end against the real upstream, not only against the controlled upstream the tests use. Run the entry point a user runs (`nx run <app>:start`) into a real destination, then inspect the actual output: tables or files, checkpoints, and a second run with no upstream changes that behaves as the sync strategy promises (a snapshot stream writes nothing).
- Live checks are run, not deferred. Behavior counts as unverified only when the environment cannot produce it, and a backlog item does not replace the check.
- Every agent-backlog item opened during the work, and every open item related to the source, is closed.
- Each gotcha above is checked against the diff.
- The final report lists implemented streams, checks run, live checks, and anything unverified along with what blocked it.
