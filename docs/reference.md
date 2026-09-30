# API and behavior reference

[Back to the README](../README.md)

Detailed sync, storage, connector, and failure contracts for `elt`.

## Working example

The examples below live inside `apps/apple/src`: import pipeline types from `elt`, the SQLite destination and checkpoint store from `elt-sqlite`, and Apple connectors directly from their source modules. Later snippets reuse `notes`, `sqlite`, and `checkpoints` from this example.

```ts
import { Connection, Copy, Pipeline } from 'elt';
import { SQLiteCheckpointStore, SQLiteDestination } from 'elt-sqlite';
import { AppleNotesSource } from './sources/apple-notes/apple-notes-source.ts';

const notes = new AppleNotesSource();
const sqlite = new SQLiteDestination({ path: './notes.sqlite' });
const checkpoints = new SQLiteCheckpointStore({ path: './checkpoints.sqlite' });

const connection = new Connection({
  name: 'apple-notes',
  source: notes,
  destination: sqlite,
  checkpoints,
  steps: [
    new Copy(notes.accounts, sqlite.table('accounts', columns => [
      columns.text('id').primaryKey(),
      columns.text('name').notNull(),
    ])),
    new Copy(notes.notes, sqlite.table('notes'), {
      id: 'notes-to-sqlite',
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
    }),
  ],
});
const pipeline = new Pipeline({ connections: [connection] });

const results = await pipeline.run(); // [{ copy, count, deleted }, ...] in declaration order
```

A `Connection` is Airbyte's connection: one source's copies into one destination, with the checkpoints that resume them. Its `name` is what readers of sync history see. A `Pipeline` is the orchestrator over one or more connections; see [execution and failures](#execution-and-failures). Accounts uses an explicit destination projection; notes uses inferred columns and deduplicates on the stream's own `id` key. Apple Notes exposes `accounts`, `folders`, `notes`, `inlineAttachments`, and `attachments` directly. `discover()` returns the same immutable descriptions for generic code that enumerates streams. Neither discovery nor constructing a declaration reads Notes or opens storage.

## Sync modes

`syncMode` selects extraction. `destinationSyncMode` selects loading. Both SQLite and Markdown files/folders implement these five combinations:

| Extraction | Loading | Result |
| --- | --- | --- |
| `full_refresh` | `append` | Retain every observation, including repeated IDs within and across runs. |
| `full_refresh` | `overwrite` | Replace the target with this extraction, preserving repeated IDs. |
| `full_refresh` | `overwrite_dedup` | Replace the target with the greatest cursor value per selected key. |
| `incremental` | `append` | Resume from acknowledged source state and retain each emitted observation. |
| `incremental` | `append_dedup` | Resume from acknowledged state and reconcile each key with its greatest cursor value. |

Omitting the entire third `Copy` argument selects `full_refresh` + `overwrite`. An explicit options object requires both mode fields. Incremental + overwrite and full refresh + append_dedup are rejected; use `overwrite_dedup` for the latter outcome.

These combinations follow Airbyte's [documented sync modes](https://docs.airbyte.com/platform/using-airbyte/core-concepts/sync-modes). Its platform [maps Full Refresh Overwrite + Deduped to `full_refresh` + `overwrite_dedup`](https://github.com/airbytehq/airbyte-platform/blob/main/airbyte-server/src/main/kotlin/io/airbyte/server/apis/publicapi/helpers/AirbyteCatalogHelper.kt). Its [serializer](https://github.com/airbytehq/airbyte-platform/blob/main/airbyte-commons-protocol/src/main/kotlin/io/airbyte/commons/protocol/DefaultProtocolSerializer.kt) maps `overwrite_dedup` to `append_dedup` for refresh-capable destinations, using generation metadata, and to `overwrite` otherwise. The separate [wire protocol enum](https://github.com/airbytehq/airbyte-protocol/blob/main/protocol-models/src/main/resources/airbyte_protocol/v0/airbyte_protocol.yaml) does not include `overwrite_dedup`. This library uses the platform vocabulary and an in-process protocol; it does not claim Airbyte wire compatibility. The default and tie policy below are explicit library choices.

### Conflict policy for deduplicating loads

`dedupPolicy` selects how `append_dedup` and `overwrite_dedup` resolve a conflict on the selected key:

| `dedupPolicy` | Upsert guard | Use when |
| --- | --- | --- |
| `cursor_newer` (default) | `WHERE excluded.<cursor> > target.<cursor>` | The cursor advances independently of identity, so a lower cursor means a stale replay. |
| `replace` | none | The upstream restates facts it already published, so the newest extraction is authoritative. |

A deduplicating copy that leaves `dedupPolicy` unset uses `cursor_newer`, or `replace` for a stream with `sourceDefinedCursor`. Both destinations apply the policy: SQLite as the upsert guard above, Markdown when it merges each record with the previously published one or with an earlier record from the same run.

Selecting `cursor_newer` with a cursor that is a member of the primary key is rejected. A conflict on that key implies an equal cursor, so the guard could never fire and a restated record would load as a no-op that reports a count without changing the row. The rejection names the field and points at `replace`.

```ts
// searchAnalyticsQueries declares the key [siteUrl, date, query].
new Copy(source.searchAnalyticsQueries, destination.table('raw_searchAnalyticsQueries'), {
  id: 'search-analytics-queries',
  syncMode: 'incremental',
  destinationSyncMode: 'append_dedup',
  dedupPolicy: 'replace',
  cursorField: 'date',
});
```

Capabilities are immutable metadata:

```ts
notes.notes.supportedSyncModes; // ['full_refresh', 'incremental']
sqlite.supportedDestinationSyncModes;
// ['overwrite', 'append', 'append_dedup', 'overwrite_dedup']
```

### Deletions

A stream that declares `emitsDeletes` can send `DELETE` messages during incremental reads, each carrying exactly the stream's `primaryKey` fields. Such a stream always declares its key, and its incremental copies must use `append_dedup`, which deduplicates on that key, so the destination can find the row:

| Destination | Effect of `DELETE` |
| --- | --- |
| SQLite `append_dedup` | Deletes the row with that key inside the copy's transaction. |
| Markdown `append_dedup` file or folder | Drops the record before the target is republished. |

Records and deletions apply in the order the source emits them, and deleting an absent key is a no-op, so replaying a run is safe. A deletion is rejected when the stream does not declare `emitsDeletes`, when its key is malformed, or when the load does not deduplicate. Results report accepted deletions as `deleted`, separately from `count`.

### Target ownership

A target has one writer, as in Airbyte, where one stream owns one table and ["more than one Airbyte connection to sync to the same destination stream… isn't permitted"](https://github.com/airbytehq/airbyte/blob/65c1b23b53ca4929ff18adbc3a3ef92666a3fffe/docs/platform/using-airbyte/configuring-schema.md#L42-L54). An overwrite empties the whole target and a snapshot copy deletes keys it once saw, so a second writer's rows would be lost.

A writer is the copy's `id`, or the source identity and stream name for a copy without one. Every destination records the writer of each target, stored with the target and committed with its first load. Before a copy extracts or changes anything, the target refuses any other writer with `TargetOwnedError`, which names both. A pipeline refuses two writers of one target among the copies of all its connections before running any. It compares each destination's `location(target)`, which is globally unique: `//host:port/database/"schema"."table"` for Postgres, `<path>#<table>` for SQLite, and `<directory>/<name>` for Markdown. The owning writer may change its own mode or key.

To reset or reassign a target, clear it with its owning copy, as with Airbyte's Clear: `pipeline.clear()` (or `pipeline.clear([copy])`, which routes each copy to its connection, or `connection.clear()`) empties each target, releases its writer and removes the copy's checkpoint, so the next run reloads from scratch. A SQL table is emptied rather than dropped, so views built on it, such as the warehouse marts, keep working; a Markdown file or folder is removed. Clearing refuses a target another writer owns. A target dropped by hand also releases its writer, but a copy that still has a checkpoint for it fails with `TargetMissingError` before extracting, since resuming would load only what changed since the checkpoint; clear the copy to reload it. SQLite and Postgres keep writers in the reserved `_mac_elt_writers` table; Markdown keeps it in the file's header comment or the folder's marker file.

Several properties or accounts share tables through one [partitioned source](#partitioned-streams), which is one writer.

## Identity, cursors, and schemas

Three separate concepts control identity:

- `Stream.primaryKey` is the source's own identity, like `sourceDefinedCursor` (Airbyte's `source_defined_primary_key`). A deduplicating copy of a stream that declares one uses it; it does not create SQL uniqueness or select deduplication by itself.
- `Copy` option `primaryKey: ['id']` or `['tenantId', 'id']` selects the identity only for a stream that declares none. A copy that selects `primaryKey` on a keyed stream is refused at construction (`Stream <name> defines its own primary key; omit primaryKey`).
- `.primaryKey()` on a SQLite column is a physical constraint. Conflicting append operations fail and roll back that copy; they never silently become updates.

Both deduplication modes need a key: the stream's own, or for a keyless stream the copy's `primaryKey` (`Stream <name> declares no primary key; select primaryKey` otherwise). Non-deduplicating loads refuse `primaryKey`. `cursor_newer` also requires `cursorField`; `replace` works without one. A stream with `sourceDefinedCursor` has no cursor field: its copies omit `cursorField`, and its deduplicating loads default to and require `replace`. Fields must be top-level scalar properties declared with one non-null JSON Schema type. Keys support text, finite numbers, safe integers, and booleans; cursors support text or numbers. Missing/null values fail. Composite keys are supported; nested field paths and nullable key/cursor schemas are not. Explicit SQL projections must include all selected keys and the cursor with matching types.

The greatest cursor wins. Older arrivals are ignored after validation. Equal cursors retain the first stored record, including across runs. This makes replay deterministic; a source that changes content without changing its cursor cannot distinguish those versions. Text uses UTF-8 byte order, matching SQLite `BINARY`; timestamps should use one canonical UTC ISO format. All observations are validated, even losing versions.

SQLite inference maps flat JSON Schema fields: `string` → `TEXT`, `integer` → `INTEGER`, `number` → `REAL`, `boolean` → `INTEGER` with a 0/1 constraint. Nullable scalars are supported for ordinary fields. Missing optional fields become SQL `NULL`. Explicit columns support `text`, `integer`, `real`, `blob`, and `boolean`; they allow null unless marked `.notNull()` or `.primaryKey()`. Missing/undefined explicit fields fail. An explicit projection can omit unsupported nested fields.

SQLite creates strict tables. Existing SQL constraints remain authoritative; there are no schema migrations. Table names starting with `_mac_elt_` are reserved. Deduplication additionally verifies stored key/cursor column types and rejects null keys/cursors. It uses native [UPSERT with a cursor comparison](https://www.sqlite.org/lang_upsert.html) and a reserved `_mac_elt_dedup_*` unique index. Changing to ordinary append/overwrite removes that mode-owned index while retaining explicit constraints. An existing append-history table with repeated keys must be replaced with `overwrite_dedup` before incremental deduplication can start.

Every SQLite copy adds `loaded_at`, a reserved UTC load timestamp. The `count` returned for a committed copy is the number of accepted input observations, including deduplication no-ops, and `deleted` is the number of accepted deletions, including keys that were already absent; neither is the final row count.

## Incremental extraction and checkpoints

Incremental copies require an explicit stable `id` and a [checkpoint store](#checkpoint-stores). IDs must be unique across every connection of a pipeline, and each ID's progress is its own. A connection copies each stream once, so loading one stream into two targets takes two connections with two IDs (see [Read context](#read-context)).

`Source.read(catalog, states)` hands each incremental stream its saved state, `null` on its first run, and `extract` receives it as `state`. `extract` emits `{ stream, data }` records, `{ type: 'DELETE', stream, key }` deletions and `{ type: 'STATE', stream, state }` checkpoints. Their text must be well-formed Unicode: a string or field name with a lone surrogate fails its stream, because SQLite and Markdown would store it as U+FFFD and Postgres refuses it. State is losslessly JSON serializable and source-owned; destinations do not interpret it.

Each checkpoint is a commit point, as in Airbyte: the writer commits everything before it, then acknowledges it, and the store saves it before the load continues. A run that fails later keeps every checkpoint it acknowledged and resumes from the last one. No acknowledgement means no advancement, even if the source mutates its input state. When `extract` throws, `Source.read` reports a `FAILED` stream status (Airbyte's error trace) for that partition or stream instead of throwing; the stream's stage discards what it staged since its last checkpoint and commits nothing more until the next one. A connector signals a failed read by throwing, never by yielding nothing. A full refresh carries no checkpoints, so it commits once at the end and any failure keeps the previous target.

The store binds each ID to the source identity, target declaration, schema and selected configuration. A changed binding fails before extraction. Use a new ID or explicitly reset progress:

```ts
await checkpoints.reset('notes-to-sqlite'); // Next read starts from null; destination data is unchanged.
await pipeline.run();
```

`reset` keeps the loaded rows, as Airbyte's refresh that keeps records: resetting append progress may duplicate data, and resetting deduplicated progress reconciles replayed records. To drop the rows too, [clear the copy](#target-ownership). Do not share a state file between independent machines or put it inside a managed Markdown folder. Its parent directory must exist.

A checkpoint is saved after its rows commit, in a separate store. If the rows commit but the save fails, the copy reports that failure with the committed counts, and the next run replays from the last saved checkpoint: delivery is **at least once**. Append keeps replayed observations; deduplication reconciles them. Resumable full refresh is not implemented.

### Checkpoint stores

State belongs to the orchestration, not the destination, as in Airbyte, so any store works with any destination, including one that cannot hold state itself: the replication saves each checkpoint only after its stream's rows before it committed. `CheckpointStore.run(bindings, work)` owns that protocol for every incremental copy of a pass at once (the binding check per copy, the cloned input state, advancing only on a commit, `reset` and `clear`). A store supplies a session that holds every copy's lock for the whole pass and whose `save` is durable when it resolves.

| Store | Keeps state in | Concurrency |
| --- | --- | --- |
| `SQLiteCheckpointStore({ path })` from `elt-sqlite` | A `checkpoints` table in its own file, owner-only (`0600`). Use it with SQLite and Markdown destinations. The file must differ from a SQLite destination file and must not sit inside a managed Markdown folder. Its parent directory must exist. | The file's write lock, held for the pass and retaken in the same step as each save commits: passes sharing a file run one at a time, and a concurrent attempt fails with SQLite's lock error. Native locks release on process exit. Connections pass side by side, so give each connection, and each independent pipeline, its own file. |
| `PostgresCheckpointStore({ url, schema })` from `elt-postgresql` | `<schema>._mac_elt_checkpoints` (`id`, `binding` and `state` as `JSON`, which keeps state that `JSONB` would refuse). It sits beside the data, so `DROP SCHEMA … CASCADE` resets both. | A session advisory lock per copy `id` on its own connection, taken in sorted order: different ids run in parallel, and a run that finds one id in use releases the ones it took and fails with "in use by another run". Each save autocommits, so no checkpoint transaction stays open while the load runs. The table is created in its own committed transaction under the writers' schema lock. |

### Snapshot streams

A source without a change feed can still load incrementally with `diffSnapshot(stream, records, state)`. The stream declares `sourceDefinedCursor` and `emitsDeletes`; the source passes one complete scan and the previous state:

```ts
protected override async *extract(configuration, state) {
  yield* diffSnapshot(configuration.stream, this.scan(configuration.stream), state);
}
```

The state is `{ snapshot: { <primary key JSON>: <SHA-256 of the record> } }`. Each run emits new or changed records, a `DELETE` for every key the scan no longer contains, and the new snapshot as the only `STATE`. Unchanged records produce no writes. The first run (`null` state) loads everything and deletes nothing.

- **Replay:** if the checkpoint save fails after the data committed, the next run diffs against the older snapshot, re-applies the same upserts and deletions, and reaches the same rows.
- **Failures:** an empty scan deletes every row. The source must throw on a failed read and never yield an empty collection instead. A key repeated within one scan is rejected, so a source that reads overlapping windows deduplicates first.
- **Cost:** the source still reads everything each run; only destination writes shrink. The state holds one key and a 43-character fingerprint per row, so it grows with the stream.
- **Reset:** resetting the checkpoint makes the next run reload everything but forgets which rows exist, so rows deleted upstream meanwhile stay behind. Reset together with clearing the target, or run a full-refresh overwrite.

When the records come from inputs the source can fingerprint without reading them, such as files whose stat identifies their content, `diffGroupedSnapshot(stream, groups, state)` skips the reading too. Each group is `{ key, fingerprint, records() }`: one input, a fingerprint of it, and a function that reads its records. A group whose fingerprint equals the one saved for its key keeps its saved rows and `records()` is never called; every other group, and any group whose fingerprint is `null`, is read and diffed record by record. The state is `{ groups: { <group key>: { fingerprint, snapshot } } }`, with `snapshot` as above.

- **Deletions:** a key that no group produced this run, carried or read, is deleted, so a vanished input deletes its rows and a changed one deletes rows it no longer produces. The groups must still come from a complete listing: the source enumerates every input on every run and skips only the reading.
- **Fingerprints:** a fingerprint must change whenever the group's records could, including when the source's own parsing changes. A version constant in the fingerprint does that. A fingerprint that misses a change keeps stale rows without any error.
- **Moves:** a row that moves to another group is compared with its previous fingerprint wherever it was, so it loads only if it changed. A key produced twice in one run, including by a carried group, and a group key repeated in one run are rejected.
- **Airbyte:** the [file-based cursor](https://github.com/airbytehq/airbyte-python-cdk/blob/d5536bc78c261a5f7d89595cb811c8bad676e251/airbyte_cdk/sources/file_based/stream/cursor/default_file_based_cursor.py#L82-L111) also skips unchanged files, but by modification time alone, keeps at most 10,000 files before falling back to a time window, and never emits deletions. Groups keep every fingerprint, compare it for equality rather than recency, and delete from the complete listing.

### Partitioned streams

One source can read a stream as several partitions, such as one per Search Console property or per account. The stream declares `partitionKey`, a subset of its `primaryKey`; the source lists the partitions from its configuration and receives each one in `extract`:

```ts
protected override partitions(stream) {
  return this.siteUrls.map(siteUrl => ({ siteUrl }));
}

protected override async *extract(configuration, state, partition) {
  // state is this partition's own checkpoint, or null the first time.
}
```

`Source.read` calls `extract` once per partition, in the listed order, and keeps each partition's state apart. The checkpoint is `{ partitions: [{ partition, state }] }`, owned by the library. Each time a partition checkpoints, the library emits the whole envelope, holding that partition's new state and every other listed partition's latest one, so each partition commits as it finishes:

- **New partition:** it receives `null` and starts from the source's normal beginning, for example a full history backfill, while the others resume.
- **Removed partition:** it leaves the next checkpoint; its rows stay loaded. Reading it again later starts it from `null`.
- **Identity:** the partition list is not part of the source identity or the checkpoint binding, so adding or removing a partition never invalidates the others' checkpoints.
- **Rows:** every record and every `DELETE` key must carry its partition's values; a row naming another partition, or none, fails that partition. The `partitionKey` fields are members of the stream's `primaryKey`, so a deduplicating copy's key always includes them.
- **Failures:** as in Airbyte, a failing partition does not stop the others. Its rows since its last checkpoint are discarded and it keeps its saved state, so the next run retries it from there; the other partitions commit and advance. The copy then reports the failed partitions, and the run fails naming each one. A failing partition is never skipped silently.
- **Full refresh:** partitions are read the same way without state, and an overwrite replaces the whole target with every listed partition.

Partitions are declared without I/O: `partitionKey` fields must be distinct non-null scalar members of the primary key, and the list must be non-empty with no repeats.

### Read context

A pass is one connection's read: one `Source.read(catalog, states)` over every stream the connection selected, as Airbyte's `read(config, catalog, state)`. `Pipeline.run()` makes one pass per connection. The source opens one context for the whole read, so related streams describe the same moment of the source; separate reads would let a join stream reference a row its parent stream never saw.

```ts
class ChatSource extends Source<ChatDatabase> {
  protected override open(streams) {
    return ChatDatabase.open(this.path); // AsyncDisposable, disposed when the read ends
  }

  protected override async *extract(configuration, state, partition, database) {
    // database is the read's context
  }
}
```

- **Contract:** every source implements `open(streams)`, receiving the streams the read covers. An upstream with a read transaction pins it (Messages; Notes; Contacts, once per account store). One without reads every selected stream up front in one change-free window and serves the streams from that snapshot (Calendar and Reminders, see [EventKit consistency](#eventkit-consistency)). A source whose streams need not agree returns an empty `AsyncDisposableStack` (Search Console).
- **Stream status:** each stream reads as `STARTED`, its messages, then `ENDED`; a partition or stream that failed adds `FAILED` with its error. Only `Source.read` creates a `StreamStatus`; one yielded by `extract` fails its stream with a `TypeError`, as does a message naming any stream but the one being extracted, so a stream can never write into a sibling's target.
- **Interleaving:** `protected concurrency` (default 1) sets how many streams read at once; their messages interleave. A stream is asked for its next message only after the consumer took its last one, so a record's file stays valid until the consumer advances. A source that raises it reads its context from several extracts together. Partitions of one stream always read one after another.
- **Lifetime:** the context opens when the read starts and closes when it ends, including when it fails. A watch reads once per pass and holds nothing while idle, since a long read can block the upstream's own maintenance.
- **Failures:** a context that cannot open (a denied permission, a missing store) fails every copy of that pass; `PipelineError.cause` is the error. Other connections' passes are unaffected.
- **One copy per stream:** a connection copies each stream once (`Connection <name> copies each stream once`), as Airbyte's configured catalog lists each stream once. To load one stream into two targets, use two connections.

#### EventKit consistency

EventKit has no read transaction, so Calendar and Reminders contexts read optimistically: a watcher subscribes to `EKEventStoreChangedNotification`, every selected stream is read, and the reads repeat if a change arrived during them or within 250 ms after, the notification's delivery delay. Five disturbed attempts in a row raise `EventKitChangingError`. Each attempt is one `eventkit` helper process that reads every selected stream. The snapshot holds the selected streams' records in memory for the run. Measured on 2026-09-29 (macOS 27): a full Calendar read from 2000 to 2027 (10,956 events, about 110,000 ICS parameter rows) took about 6 s, and Reminders about 0.1 s.

### Apple Notes behavior

The source reads Notes' own Core Data store, `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`, read-only under Full Disk Access; Notes does not need to be open. Each run reads every selected stream inside one SQLite read transaction, so notes, attachments and folders come from the same moment. Note bodies are gzipped protobuf documents and tables are gzipped CRDT documents; both are decoded in-process.

| Stream | Key | Contents |
| --- | --- | --- |
| `accounts` | `[id]` | Name and Notes' numeric account `type`. |
| `folders` | `[id]` | Account, parent folder (nested folders), name, `type` (`1` is Recently Deleted), a smart folder's query, and whether it is shared. |
| `notes` | `[id]` | Folder, account, title, plain `text`, `markdown`, created and modified times, `pinned`, Notes' own `hasChecklist` and `checklistInProgress` flags, `locked`, `shared`. |
| `inlineAttachments` | `[id]` | Tags, mentions, links to other notes and calculation results as Notes stores them: `type` is Notes' identifier (for example `com.apple.notes.inlinetextattachment.hashtag`), `text` is what the note shows (`#travel`), and `target` what it points at: a tag's normalized name (`TRAVEL`), or for a link to another note that note's `applenotes:note/<id>` URL. |
| `attachments` | `[id]` | Type identifier, title, file name, URL, Notes' summary, recognized text (`ocrText`, `handwritingText`), image labels, audio `transcript`, size, duration, dimensions, location, times, and `availableLocally`. Supports file reads. |

A note's content lives in one place, its `markdown`: checklists render as `- [x]` items and tables as Markdown tables where they sit in the note. They are not repeated as separate streams.

`markdown` renders Notes' paragraph styles and runs: Title, Heading and Subheading as `#`, `##` and `###`; bullet, dashed, numbered and checklist lists with their indentation; Monospaced as fenced code; block quotes; bold, italic, strikethrough and links. Underline, fonts and colors have no Markdown form and are dropped. A table is rendered in place, an inline tag or mention as its text, a link to another note as `[title](<applenotes:note/…>)`, and a file as `[name](attachment:<id>)` naming its `attachments` row. `text` is the note's visible text with inline tags and mentions kept and file placeholders removed.

All streams are [snapshot streams](#snapshot-streams): incremental copies select no `cursorField` and use `append_dedup` keyed by the stream's key. Each run reads the whole store, writes only new and changed records, and deletes records that disappeared, including rows Notes marks for deletion. Reading is cheap: the store is local SQLite, so a run over thousands of notes takes milliseconds before decoding.

Notes in Recently Deleted are notes in that folder, so they remain in the export until permanently deleted. Notes that Notes has listed but not yet downloaded from iCloud have no folder, title or dates; they are left out until they arrive. A locked note keeps its title, dates and flags; its text and Markdown stay out, and its attachments keep only their type, name, size and times.

Only Notes syncs iCloud notes on the Mac. While Notes is closed, the store holds what Notes last synced: edits made on other devices reach it the next time Notes runs, which a [Notes watch](#watching-for-changes) arranges by launching Notes hidden.

The store's layout changes between macOS releases. The source reads the macOS 26 layout and checks every column it uses before reading; a store without one fails with `NotesSchemaError` naming the missing columns rather than loading misplaced fields. A store that cannot be opened (missing, or no Full Disk Access) fails with `NotesUnavailableError`.

## Watching for changes

Use the same configured pipeline for continuous synchronization:

```ts
const controller = new AbortController();

for await (const { connection, outcomes } of pipeline.watch({ signal: controller.signal })) {
  // This pass's copies have already extracted, loaded, and saved their checkpoints.
}

// Call controller.abort() from your app's stop/shutdown handler.
```

Watching preflights every connection, then each connection watches its own source: it subscribes before the initial synchronization and runs a pass over the copies whose streams receive notifications. It uses the existing copy modes: incremental Notes and Calendar copies stay incremental, and full-refresh copies stay full refresh. Notifications do not provide records or turn a full-refresh copy into an incremental one. `run()` remains a single execution: the Apple app's `main.ts` uses it, and `serve.ts` watches.

The source owns change detection:

- **Calendar and Reminders:** a persistent `eventkit watch` helper process subscribes to native `EKEventStoreChangedNotification` notifications. These invalidate all selected streams because EventKit does not identify individual changes. The notification covers the whole event store, so a Calendar edit also re-extracts a Reminders watch, and a Reminders edit also re-extracts a Calendar watch. The existing EventKit permission requirements apply. Full-refresh overwrite reconciles deletions on the next successful pass.
- **Notes:** the watcher opens its own read-only connection to `NoteStore.sqlite` and checks `PRAGMA data_version` every second (`pollIntervalMs`); it changes with every commit another connection makes, so each save Notes commits invalidates every selected stream. Filesystem notifications are not used: Notes keeps the store and its WAL open, and FSEvents reports a write only when the file closes, which verification showed arrives when Notes quits. Because only Notes syncs iCloud notes, the watch keeps Notes running: it launches Notes hidden and in the background (`open -g -j`) when it starts and, every `launchIntervalMs` (30 s), again if Notes has stopped. It cannot tell your quit from macOS closing a hidden Notes, which happens when the system frees disk space (seen twice on a 99% full disk, within minutes of a hidden launch), so it relaunches in both cases. A running Notes is left as it is. Watching needs the same Full Disk Access as reading.

A connection's passes are serial; passes of different connections run side by side, and each waits only on the consumer, so a slow source never holds back another. Notifications received during extraction or while the caller handles a result are coalesced into that connection's pending set of streams, so they cause a subsequent pass without an unbounded queue of sync jobs. A connection's first invalidation must cover every stream it selected. Each pass yields a `Pass`, `{ connection, outcomes }`, once its loading and checkpoint persistence finished; each outcome carries the committed `count` and `deleted` (accepted observations, including deduplication no-ops and absent keys) and its `failures`, empty when it loaded completely. As Airbyte keeps a connection's schedule after a failed sync, a pass that did not load completely does not end the watch: the caller sees its failures, the failed partitions keep their checkpoints, and the next invalidation of that stream retries them.

A connection whose watcher fails stops alone, and is recorded as a failed attempt when the pipeline has a [sync history](#sync-history); the other connections keep watching. Once every connection has stopped, or the signal aborts, the stopped connections' errors are thrown together as an `AggregateError` whose message joins `Connection <name>: <message>` entries. No retries between invalidations, periodic reconciliation or automatic disabling are added.

Aborting stops native observation, lets each in-flight pass finish and yield its result, and prevents another pass. Breaking the loop also closes the watchers. A new watch session subscribes and performs an initial pass again, using the saved checkpoints. Notifications themselves are not durable, and the source's existing snapshot/cursor limitations still apply.

Custom sources declare a `catalog` and implement `observe({ streams, signal }): AsyncIterable<readonly Stream[]>` and `coverage(stream): ExtractionCoverage`, the source's own statement of what a pass over that stream asks the upstream for (see [sync history](#sync-history)). The base `Source` owns `discover()`, `validate()`, and `watch()`: before extracting or observing, it rejects any stream that is not the same object as its catalog's stream of that name. A stream's schema shapes the destination, so a lookalike stream with a matching name is refused. Add source-specific selection rules, such as a required cursor field, by overriding `validateExtraction()`. In `observe()`, establish observation before yielding all selected streams once; then emit the affected selected streams until cancellation. The connection keeps consuming these invalidations while it loads records. Close native resources when aborted or when the iterator is closed; errors must propagate. `Stream` remains immutable metadata, and loading continues through `Source.read`, `Copy`, and the destination writers.

Automated verification covers actual filesystem events in temporary storage, the EventKit helper's watch subscription and its shutdown on abort, and destination/checkpoint visibility before results are yielded. The native filesystem test requires an environment that permits filesystem notifications; this host's sandbox reports `EMFILE` even for a single temporary-directory watcher, while the same probe succeeds outside it.

Live verification on **2026-09-22**, using **macOS 26.6.2 and Node.js 26.8.1**, exercised the existing sources, `Pipeline.watch()`, `Copy`, and temporary SQLite destinations without mocking notifications or extraction. Calendar and Reminders each completed four observed passes: initial sync, creation, update, and deletion. Their mutations were real EventKit writes from separate OSA processes. SQLite assertions ran after the watcher yielded completed loads.

| Source stream | Live assertions |
| --- | --- |
| Calendar `events` | A uniquely labeled event appeared, its changed title and start time reached SQLite, and deleting it removed the exported row. The fixed occurrence window was `2026-09-22T00:00:00.000Z` to `2026-09-23T00:00:00.000Z`. |
| Reminders `reminders` | A uniquely labeled reminder appeared, its changed title and completed status reached SQLite, and deleting it removed the exported row. |

Watchers were closed after verification. The Calendar test event, temporary Reminders list, and temporary databases were removed. EventKit cleanup was checked through fresh native reads. Existing user records were not modified. This live pass covered the primary streams and SQLite; Calendar/Reminders GUI edits, other streams, and Markdown were not exercised live.

**Notes live verification** on **2026-09-25**, macOS 26.6.2 and Node.js 26.8.1, against the real store with Notes closed, the process holding Full Disk Access:

- Without Full Disk Access the group container cannot even be listed (`EPERM`); with it, the store opens read-only while Notes is closed or running.
- Only Notes writes note and iCloud-sync data: every persistent-history transaction on note, folder, account and server-change-token entities came from `com.apple.Notes`. With Notes closed the store does not change; an edit made on an iPhone reached the store only after Notes was launched hidden, and the watch loaded it within a second of Notes committing it.
- Recursive filesystem notifications on the container did not report Notes' WAL writes while Notes ran; the event arrived when Notes quit. Per-commit `data_version` polling saw every commit.
- A hidden launch (`open -g -j`) left the frontmost app in front and put no Notes window on screen, and Notes synced on launch. macOS closed the hidden Notes twice within minutes to free disk space on a 99% full disk; the watch relaunched it hidden on its next check.
- The exporter loaded every stream; a second run with no changes wrote nothing. Temporary notes made for the probe (formatted text, a table, and PNG, PDF, M4A, TXT and ZIP attachments) matched what was created: headings and emphasis, lists, the table's cells, each file's bytes, and text parsed from the PDF and TXT.
- Ten of the store's note rows were placeholders for notes not yet downloaded from iCloud (no folder, title or dates); the export leaves them out and then equals what Notes shows.
- A Markdown file imported into Notes produced real Title, Heading, Subheading, checklist (one done, one open), Monospaced, block quote and table formatting; the export rendered each as its Markdown form and set `hasChecklist` and `checklistInProgress`. A hashtag typed into a note became an `inlineAttachments` row (`#macEltTag`, target `MACELTTAG`) and appeared in the note's `text` and `markdown`. The watch loaded each edit within seconds of Notes saving it.
- The probe notes and folders were deleted afterwards and purged from Recently Deleted; the store then marked them for deletion.

- A link to another note, made through Notes' `>>` picker, became an `inlineAttachments` row of type `com.apple.notes.inlinetextattachment.link` whose target is the linked note's `applenotes:note/<id>` URL, and rendered in `markdown` as a Markdown link to it. A pasted web address became a link in the text.

Not verified live, each for a stated reason:

- **Audio recordings and transcripts, locked notes, rich web-link previews:** Notes keeps Record Audio, Lock Note and Share disabled unless a person has the note focused, so scripts cannot start them. Locking also needs the Notes password.
- **Scans and sketches:** Notes on the Mac inserts them only from an iPhone or iPad camera or pencil.
- **Mentions:** they exist only in a note shared with another iCloud user.
- **Locations:** added only through the Maps share sheet.

Checklists, tags, tables and a locked note were also read from Apple-made macOS 26 sample stores. The unverified kinds are read as the published format describes them; to verify one, create it in a Notes folder and run the exporter.

## Attachment files and document parsing

```ts
import { LocalFiles } from 'elt';
import { MacOSDocumentParser } from './parsers/macos-document-parser.ts';

const files = new LocalFiles({ directory: './outputs/attachments' });
const attachmentCopy = new Copy(
  notes.attachments,
  sqlite.table('attachments', c => [
    c.text('id'),
    c.text('noteId'),
    c.text('content').from(notes.attachments.file).parse(new MacOSDocumentParser()),
    c.text('attachmentRef').from(notes.attachments.file.store(files)),
  ]),
  {
    syncMode: 'full_refresh',
    destinationSyncMode: 'overwrite',
  },
);

await new Pipeline({
  connections: [
    new Connection({
      name: 'apple-notes-attachments',
      source: notes,
      destination: sqlite,
      steps: [attachmentCopy],
    }),
  ],
}).run();
```

This stores the selected source metadata, parsed `content` and an `attachmentRef` as TEXT. The original attachment ID and containing note ID remain available for joins. `LocalFiles` stores the original bytes and returns their absolute local path. SQLite and Postgres receive only that ordinary text value: they do not construct paths or write attachment files. The Apple exporter stores only the `attachmentRef` for every stream with files, under `outputs/apple-<name>-files`; it does not parse file text.

Storage is selected on each file reference with `.store(files)`, independently of the connection and destination. Two fields can use different stores, and copies can share one store without sharing file ownership. Constructing a store or declaring a field performs no I/O. A stored reference and parsed text must be separate fields; applying `.parse()` to a stored-file field is refused.

`LocalFiles` resolves the chosen directory at construction. It streams each file in chunks of at most 4 MiB into a temporary file, syncs it, then publishes it atomically. Files live in `.elt-files/<scope hash>/<content hash><extension>` beneath that directory. The scope identifies the destination target, copy writer and field; the content hash makes repeated saves stable without overwriting an existing reference. A safe source extension is preserved; the original filename stays in source metadata. Empty files are real zero-byte files. Unavailable source files produce null references.

The shared transfer saves files before applying records and commits database rows before removing obsolete files. It asks each destination for the references its committed rows actually retain, so a cursor-rejected update cannot delete the winning attachment. Append retains the files of every retained observation; replacement, deletion, empty overwrite and `Copy.clear()` remove files only when this scope no longer references them. Cleanup runs while the target's writer lock is held. Source failures discard pending rows and reconcile against the retained rows.

Files and database rows do not share a transaction. A failed save prevents its rows and checkpoint from advancing. A cleanup failure after a database commit preserves that committed data but prevents the checkpoint from advancing; replay is safe. A failed database write or interrupted run can leave unreferenced files; the next run reconciles them before extraction using the current committed references. Missing referenced files, non-file references and invalid managed directories fail explicitly. Keep these generated files intact until clearing and rebuilding their copy.

For another storage backend, implement the exported `FileStorage` contract: a stable `identity`, a `reference` sentence telling readers what a saved reference is (Postgres writes it as the reference column's comment), `save(scope, FileContent)` returning a durable, immutable, repeatable text reference, and `retain(scope, references)` removing only that scope's unreferenced objects. Identity participates in the copy's checkpoint binding. The transfer treats references as opaque strings, so a future S3 store can return its own reference format without changing database destinations. Only `LocalFiles` is supplied today. Reconciliation scans retained references and the scoped directory at each commit; it does not maintain a separate object index.

The columns declare what to extract. `Copy` collects those declarations; `Source.read()` performs parsing and exposes original files as a `FileContent`, valid until its record is consumed. The shared transfer resolves stored-file declarations before sending records to the destination. Omitting a stored reference avoids retaining the original file; omitting all file-derived columns avoids exporting files altogether.

### Explicit database byte storage

Use `c.blob('bytes').from(notes.attachments.file)` when the database should own the original bytes instead. This is independent of `.store(files)` and remains available for both SQL destinations. The file and row then commit together in the database.

SQLite stores an original file in chunks, because one BLOB is capped at 1,000,000,000 bytes (`SQLITE_MAX_LENGTH` in Node's build) and a whole-file value would sit in memory. The `bytes` column holds an INTEGER file id, and the table `_mac_elt_files_<table>_<column>` holds `(file, n, bytes)` rows of up to 4 MiB, `n` counting from 0. An empty file has one empty chunk. Triggers remove a row's chunks in the same transaction whenever the row is deleted, overwritten or replaced, and a record that a deduplication guard rejects stores none. Read a file back in order:

```sql
SELECT c.bytes FROM "_mac_elt_files_attachments_bytes" AS c
WHERE c.file = (SELECT bytes FROM attachments WHERE id = ?)
ORDER BY c.n;
```

Verified on 2026-09-24 (macOS 26.6.2, Node.js 26.8.1): a 1.5 GB file loaded as 358 chunks in 3.3 s with a peak RSS of 137 MiB, and the reassembled chunks matched the file's SHA-256.

Postgres supports the same `text().from(file).parse(parser)` and `blob().from(file)` declarations. Parsed content is TEXT. An original file's column holds a UUID; its bytes live in a per-column `_mac_elt_files_<hash>` table in the destination schema, with `(file UUID, n BIGINT, bytes BYTEA)` chunks of up to 4 MiB. The hash is the first 40 hex characters of SHA-256 over `JSON.stringify([tableName, columnName])`. Join the file UUID and order by `n` to read the original. Empty files have one empty chunk; unavailable files have a null reference. The loader removes unreferenced chunks when a stage commits or is discarded, and when it reopens after a crash; clearing a copy removes its files too. A plain `blob()` column without `.from(file)` stores an inline BYTEA value.

```ts
// Text only, under a destination field name you choose.
new Copy(notes.attachments, sqlite.table('attachment_text', c => [
  c.text('id'),
  c.text('search_text').from(notes.attachments.file).parse(new MacOSDocumentParser()),
]));

// Original bytes only; no parser runs.
new Copy(notes.attachments, sqlite.table('originals', c => [
  c.text('id'),
  c.blob('bytes').from(notes.attachments.file),
]));
```

A bare table still infers the discovered metadata schema. To include all metadata alongside file-derived columns, spread `SQLiteColumns.fromSchema(notes.attachments.jsonSchema)` into the columns array. A plain `c.blob('bytes')` reads a record's existing `bytes` field into an inline BLOB. `.from(file)` selects the original source file; `.parse(parser)` requests its text representation. Original bytes require a BLOB column; parsed text and stored-file references require TEXT. The existing `.notNull()` and `.primaryKey()` constraints apply to these fields. Incompatible types, another stream's file reference, and fields colliding with source metadata or `loaded_at` fail before extraction.

`notes.attachments.file` is an immutable source reference, not a path. Other Notes streams reject file access. All declarations remain immutable and perform no I/O; the discovered source schema is never rewritten to describe destination fields. A file can supply multiple named representations in one copy. Each record is exported once; requests using the same parser instance share one parse, and original-byte requests share one read. Separate copies retain separate extraction and checkpoint progress.

Markdown targets use the same destination-independent `FileRead` declaration, alongside their existing metadata rendering:

```ts
import { FileRead } from 'elt';

new Copy(notes.attachments, markdown.folder('attachments', {
  fields: [new FileRead('content', notes.attachments.file, new MacOSDocumentParser())],
}));
```

Markdown accepts parsed text and stored-reference fields, such as `new FileRead('attachmentRef', notes.attachments.file.store(files))`, and rejects binary requests before I/O. Its `file()` target supports the same options as `folder()`.

This follows Airbyte's source-side parser and staged-file concepts: its [file parser Strategy](https://github.com/airbytehq/airbyte-python-cdk/blob/f77450f74def59598cda8e1e9a4e975031710c18/airbyte_cdk/sources/file_based/file_types/file_type_parser.py) interprets files, while [file transfer](https://docs.airbyte.com/platform/using-airbyte/sync-files-and-records) moves original content with metadata. Our parser emits plain text, not Airbyte's Markdown conversion, and we do not claim its complete format/OCR support or wire compatibility.

`MacOSDocumentParser` uses native PDFKit for PDFs with a text layer and native `textutil` for TXT, Markdown, RTF, HTML, DOC, DOCX, ODT, and WordML. It selects the format from the filename extension, preserves text/Markdown content, and strips rich formatting when converting other formats to plain text. HTML conversion does not load external resources. Images (JPEG, PNG, GIF, HEIC/HEIF, TIFF, BMP, ICO, WebP) go through Vision's accurate text recognition, one line per observation. ImageIO checks native dimensions first; images narrower or shorter than three pixels return null because Vision crashes or rejects these inputs. Voice recordings are not transcribed: macOS grants Speech Recognition only to an app bundle that declares why it asks, which neither `node` nor `osascript` is. vCards, including Messages' `.loc.vcf` locations, load as their text. A file without a known extension is identified by its leading bytes. Audio, video, unknown formats, locked PDFs, PDFs without a text layer and images without recognizable text parse to `null`, so the field loads as null and the copy continues. A file that cannot be read (a PDF that cannot be opened, an image Vision cannot decode, a `textutil` error) fails the copy. The parser's identity is `macos-document-v3`. PDF parsing uses the existing OSA command's 64 MiB output buffer and 120-second timeout. Text conversion uses Node's native `execFile` defaults (1 MiB output limit and no timeout).

Notes hands over the original file from its store, never a staged copy: `<NoteStore.sqlite directory>/Accounts/<account>/Media/<media>/[<generation>/]<filename>`, from the attachment's media row. An attachment has no file when its note is locked or it has no media row or filename (tables, links, sketches without media); a path that is not on disk (an iCloud file Notes has not downloaded) sets `availableLocally` to false. In each case the metadata loads and the file fields load as null. We never treat an attachment's URL as a download URL or invent a missing filename.

`Source.read()` is the shared template method. Source implementations provide protected `extract(configuration, state, partition, context)`, yielding metadata, optional file paths, and state. The source resolves `configuration.fileReads` into parsed text or a `FileContent` before yielding records to the destination. A path must stay readable until the consumer advances past its record: a staged copy the source cleans up afterwards, or the original file when copying it would be costly (Notes and Messages hand over their attachment files). Destinations reject any leaked path.

Extend `DocumentParser` with `parse(path): Promise<string | null>` for another parsing implementation. Return `null` when the file has no text the parser can represent, and throw only when reading it failed. Give it a stable identity that includes its version and relevant configuration; keep the implementation/configuration immutable and parse without modifying the file. A parser does not depend on Notes or SQLite. Parser identity participates in the copy's checkpoint binding; changing it requires a new copy ID or explicit checkpoint reset. Source keys and cursors remain metadata fields, and a checkpoint is still acknowledged only after the rows before it commit.

The loaded `content` can be queried with normal SQL or indexed with SQLite FTS5 in the consuming application. Parsing does not create a search index. No query API or general transformation step is part of this library.

## Connector applications

`apps/apple/src/pipeline.ts` default-exports one `Pipeline` with a `PostgresSyncHistory` and six connections: `apple-mail`, `apple-notes`, `apple-messages`, `apple-contacts`, `apple-calendar` and `apple-reminders`. Building it signs in to Google for Calendar's Drive and Gmail attachments, so `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` must be set when the app starts; discovery returns each source's static catalog. Apple loads into the shared Postgres warehouse as the loader role, with `raw_<stream>` tables and `_mac_elt_checkpoints` in each connection's `apple_<name>` schema. Apple raw schemas are not granted to the reader.

- `apps/apple/src/main.ts` (`npx nx run apple:start`), the app's one entry point, installs the sync history and watches the pipeline until `SIGINT` or `SIGTERM`. Every connection's first pass loads all its streams, side by side; after that each connection refreshes at its own source's pace, and every pass is recorded as it completes.

Calendar's coverage declares its configured window for event-derived streams and a listing for accounts and calendars; the other five Apple sources share `localAppleStoreCoverage`, the whole accessible local store.

`apps/google/src/connectors.ts` default-exports a list of `{ name, run }` entries that `main.ts` calls in order. Each `run()` owns its source configuration, credentials, pipeline, and post-load work. Search Console's builds a `Pipeline` with one `google-search-console` connection and a `PostgresSyncHistory`, runs it, and publishes its content marts after complete or partial loads once every raw table exists. Its coverage lives in `SearchConsoleSource.coverage(stream)`.

Both applications record every pass and its declared extraction coverage in PostgreSQL, without console output. `Pipeline` already includes failed streams and partitions in its errors. Connector-specific code that handles a partial failure, such as Google's marts publication, also sets exit status 1. Apple and Google stay separate apps until their later convergence.

## Execution and failures

`Pipeline({ connections, history? })` is the orchestrator. `run()` and `watch()` validate every declaration of every connection before any read: distinct connection names, copy IDs distinct across the pipeline, each connection's copies (unknown streams, a stream copied twice, unsupported combinations, invalid schema declarations, missing keys/cursors/IDs/state store), and [target ownership](#target-ownership) across connections. An invalid connection stops the whole pipeline without extraction or storage creation and, when a history is given, is recorded as a failed attempt for that connection. Preflight uses metadata; storage permissions, existing constraints and record values are checked during execution.

`run()` then makes one pass per connection, all side by side, so a slow source never holds back another. Each pass locks every incremental copy's checkpoint, opens one load on the destination, and prepares every target before reading anything: a copy whose target is refused (another writer's, or dropped while its copy resumes) fails and reads nothing. One read then covers the remaining copies. As in Airbyte, every copy runs even when another fails, and every connection's pass runs even when another's fails. Each stream stages its operations apart from the others and commits them at its own checkpoints, so an incremental copy that fails keeps what it committed and publishes nothing it staged since; a full refresh commits once, when its stream ends, so a failure keeps the previous target. Empty overwrite clears it; empty append preserves existing records. There is no pipeline-wide rollback.

Verified live on 2026-09-26 (macOS 26.6.2) with the Apple exporter run twice against real stores: the first run loaded every stream (Messages 12,573 messages, Calendar 10,941 events) in 203 s; the second, 168 s, wrote nothing for Notes, Messages, Contacts and Reminders, and for Calendar only 2 events (with 1 alarm and 2 recurrence rules) that had just entered its one-year window, and 1 account EventKit listed for the first time. A run killed mid-write left a hot journal that SQLite rolled back on the next open; nothing it staged was published. The Search Console exporter completed every stream into the Postgres warehouse the same day.

When any copy is incomplete or any pass could not run, `run()` throws one `PipelineError` once every pass ends:

```ts
import { PipelineError } from 'elt';

try {
  await pipeline.run(); // [{ copy, count, deleted }] when every copy completed.
} catch (error) {
  if (!(error instanceof PipelineError)) throw error; // Preflight errors are direct.
  // error.results contains committed counts and stream/partition failures.
  // error.cause is the first failure.
  process.exitCode = 1;
}
```

`PipelineError` is an `AggregateError`: `errors` holds every failure, `results` holds every copy's committed `count` and `deleted` beside its `failures`, in connection order then copy order. A pass that could not run, such as one whose sync history could not be written, adds its error with the message prefixed `Connection <name>: `. A failure after rows committed, such as a checkpoint that could not be saved or a cleanup error after publication, is reported the same way with the committed counts; it does not imply rollback. A count of zero also covers a committed empty input.

Declarations are frozen and reusable. `Destination.createWriter(configuration, target)` selects a storage-specific strategy without I/O; `Destination.load()` opens the pass's one hold on storage, and `load.prepare(configuration, target, { writer, resuming })` gives each stream its `Stage` (`apply`, `commit`, `discard`). Destinations own connections, files, and publication. `Copy`/`Pipeline` contain no SQL/filesystem loading branches. `Source.identity` and `Destination.identity(target)` provide stable checkpoint bindings; custom implementations must distinguish different source instances/targets/configuration domains.

SQLite holds a native writer lock for the whole pass in a `<database path>.writer-lock` sidecar containing no records. It survives individual commits and releases on handle closure or process exit; readers of the destination are unaffected. Each commit starts a fresh write transaction, so long reads block other writers to the file. Each stream stages its operations in a connection-private `TEMP` table: another stream's commit never publishes them and a crash leaves nothing behind. A commit merges one stream's staged operations into its table, with the result of applying them one at a time: a staged `DELETE` removes its key, only records after a key's last `DELETE` count, `replace` keeps the last and `cursor_newer` the first with the greatest cursor. Original files stream straight into the chunk table; chunks no row references are deleted after each merge and swept when a later run prepares the table or it is cleared. `:memory:` is allowed only for full refresh; the run's database disappears when its handle closes, so it cannot safely retain incremental progress.

### Sync history

As Airbyte's platform keeps each connection's jobs and attempts apart from any connector, the orchestrator records every pass in a `SyncHistory`, exported from `elt`. Like a `CheckpointStore`, it belongs to the orchestration: pass it as `Pipeline({ connections, history })`.

```ts
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from 'elt-postgresql';

const url = 'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';
const warehouse = new PostgresDestination({ url, schema: 'apple_notes' });

const history = new PostgresSyncHistory({ url });
await history.install();

const recorded = new Pipeline({
  history,
  connections: [
    new Connection({
      name: 'apple-notes',
      source: notes,
      destination: warehouse,
      checkpoints: new PostgresCheckpointStore({ url, schema: 'apple_notes' }),
      steps: [
        new Copy(notes.notes, warehouse.table('raw_notes'), {
          id: 'apple-notes:notes',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        }),
      ],
    }),
  ],
});
```

A pass is one connection's read over the copies it selected. `validate(connection)` refuses, without I/O, a connection the history cannot record; the pipeline calls it during preflight. `begin(connection, copies)` receives each selected copy with its `coverage` and is durable when it resolves, before the read starts, so a pass that never finishes stays visible as unfinished rather than missing. It returns a `RecordedPass`: `finish(outcomes)` closes it with what each copy loaded, and `fail(error)` closes a pass that produced no outcomes, such as an invalid connection or a watcher that stopped. The helpers `copyStatus`, `passStatus` and `passError` derive `succeeded`, `partial` or `failed` (`SyncStatus`) and the pass's error text from outcomes. `DeclaredCopy` and `RecordedPass` type the contract.

Coverage is the source's own statement, `coverage(stream): ExtractionCoverage` with `ExtractionCoverage = { description, selection }`: what a pass over that stream asks the upstream for, from the source's configuration (Calendar's `startAt`/`endAt`, Search Console's `siteUrls`), never inferred from the records it finds. `selection` holds the JSON configuration values the description refers to. Every custom source implements it.

`PostgresSyncHistory({ url })` from `elt-postgresql` records into the [warehouse](#warehouse-marts) tables `_warehouse.sync_attempts` and `_warehouse.extraction_coverage`. Its `install()` creates those tables and publishes the `marts` views `sync_attempts`, `extraction_coverage`, `sync_status` and `stream_status`; it is safe to repeat. Run it before the pipeline records its first pass. It grants nothing. It records Postgres destinations only and refuses any other connection during preflight.

## Markdown destination

```ts
import { MarkdownDestination } from 'elt-markdown';

const markdown = new MarkdownDestination({ path: './exports' });
const exportPipeline = new Pipeline({
  connections: [
    new Connection({
      name: 'apple-notes-markdown',
      source: notes,
      destination: markdown,
      checkpoints,
      steps: [
        new Copy(notes.accounts, markdown.file('accounts.md', { title: 'name' })),
        new Copy(notes.notes, markdown.folder('notes', { title: 'title' }), {
          id: 'notes-to-markdown',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        }),
      ],
    }),
  ],
});
await exportPipeline.run();
```

`file()` stores the stream in one document; `folder()` stores one record per document. Both retain every record field, including nested JSON. The optional title field supplies headings; otherwise headings use record positions. Values are escaped Markdown text; HTML stays text. Non-JSON values fail instead of being silently discarded or coerced.

Managed v3 documents include a writer comment and base64-encoded JSON record comments alongside their visible sections. Append and deduplication read these canonical records, without parsing rendered Markdown or using a SQL sidecar. These comments are not encryption. Generated files are owned by the export; manual edits are replaced. Earlier layouts have no compatibility reader or migration.

Ordinary overwrite/append requires no key. Folder filenames represent record occurrences, so repeated source IDs remain separate. Deduplicated folders hash the selected key values instead; title changes do not change identity. The old `folder({ key })` option is removed: selected deduplication keys belong to the copy. Reconciliation currently holds the target in memory and republishes its complete contents.

Target names use lowercase letters, digits, hyphens and underscores, beginning with a letter; files additionally end in `.md`. Nested paths and traversal are rejected. Only regular managed files, or managed folders containing only generated record files, can be replaced. Unmanaged files, subdirectories and symlinks are protected; siblings stay untouched.

An incremental copy publishes the whole target at each checkpoint, so a later failure keeps what earlier checkpoints published; a full refresh publishes once. A file publishes with a rename after staging and closing. A folder moves the old directory to a backup before publishing the staged directory. If publication fails, it restores the backup; if restoration also fails, it preserves the sole backup and reports its location. Folder switching has a brief path gap between renames. Publication is not a filesystem-wide or power-loss transaction.

An exclusive `.markdown-<target>.lock` directory prevents cooperating concurrent writes to either layout. Normal completion/failure removes staging and locks unless a recovery backup must remain. Abrupt termination can leave staging, a backup and a stale lock; inspect and restore the backup before removing the lock and retrying.

## Postgres destination

`PostgresDestination({ url, schema })` from `elt-postgresql` loads every table of a connection into one schema, created on first load. The URL carries credentials, so it stays private: `identity()` records host, port, database, schema and target, never the user or password. Declarations are checked without connecting.

Inferred columns follow the stream schema, and unlike SQLite the string formats get their own types, so readers can do date arithmetic:

| JSON Schema | Postgres |
| --- | --- |
| `string` | `TEXT` |
| `string` + `format: 'date'` | `DATE` |
| `string` + `format: 'date-time'` | `TIMESTAMPTZ` |
| `integer` | `BIGINT` |
| `number` | `DOUBLE PRECISION` |
| `boolean` | `BOOLEAN` |

ISO dates count years astronomically and Postgres does not, so year `0000` loads as `0001 BC`, the same day; every other year is written as given.

Explicit columns use `columns.text/integer/real/boolean/date/timestamp/blob(field)` with `.notNull()` and `.primaryKey()`. A plain `blob()` stores BYTEA; `blob().from(file)` streams originals into chunk tables, and `text().from(file).parse(parser)` stores parsed text. See [attachment storage](#attachment-files-and-document-parsing). Identifiers are case-sensitive and limited to 63 bytes, because Postgres would silently truncate a longer one; `_mac_elt_` names and a `loaded_at` column are reserved, and `pg_` schemas are refused.

Connectors describe their data with JSON Schema's `description`: at the root for the source record's meaning, and on each property for the field's meaning, nulls, units and source-local relationships. These annotations belong to the connector; they contain no destination table names. Notes describes all five of its streams and their fields this way.

Each Postgres copy publishes those annotations as native table and column comments. Both inferred and explicitly selected columns retain their source descriptions; omitted columns receive no comments. The table comment distinguishes the source record's meaning from the copy's extraction and loading modes, including append histories where source identities can repeat and deduplication keys and conflict rules. File-derived text identifies its parser; an original-file column describes its UUID and the actual chunk table used to read the bytes. `loaded_at` describes the load that last wrote the row, not source modification or sync health.

Comments are installed in the load transaction and replaced on subsequent loads; removing a property description clears its old column comment. Descriptions must be strings without NUL or malformed Unicode, and are checked before storage access. Postgres's native `format` quotes the identifiers and text. Read comments through `obj_description` and `col_description` or a catalog view built over them. A mart that changes a field's meaning must describe that new meaning itself. Current sync status and extraction coverage remain runtime data, not static schema annotations.

A run holds one connection and one write transaction on the schema, under a per-schema session advisory lock held across every commit, so writers to one schema run one at a time. Readers never wait on the lock. Each stream stages its operations in a session-private `TEMP` table and commits them at its own checkpoints:

- Operations reach the stage in batches of 1000, sent as one JSON parameter and cast per column. Every statement runs under a savepoint, because a failed statement aborts a Postgres transaction and would otherwise erase the other streams' stages.
- A commit merges one stream's stage into its table with the result of applying its operations one at a time: staged `DELETE`s remove their keys, only records after a key's last `DELETE` count, `replace` keeps the last and `cursor_newer` the first with the greatest cursor. Text cursors compare by bytes (`COLLATE "C"`). Every row of a run shares one `loaded_at` (`TIMESTAMPTZ`).
- Overwrite empties the table with `DELETE`, not `TRUNCATE`, at its stream's commit: `TRUNCATE`'s exclusive lock would block readers for the rest of the run. Until then readers see the previous load.
- Deduplication upserts on a unique index named after the table and key (`_mac_elt_dedup_<hash>`). The index is created once and rebuilt only when the key changes; a replacing load builds it after emptying the table.
- The writer of each table lives in `<schema>._mac_elt_writers` and follows the [target ownership](#target-ownership) rule.

Existing tables are not migrated: a deduplicating load checks that stored key and cursor columns keep their types and fails otherwise. Keep checkpoints in the same schema with `PostgresCheckpointStore` ([checkpoint stores](#checkpoint-stores)).

### Reader views

`table.withReaderView(schema, name)` returns the same table target, which a load also exposes as the view `schema.name`: exactly the table's columns and `loaded_at`, with the table's own comments. The view is created in the same transaction as its table, so it exists exactly when the table does, and it follows inserts, updates and deletes without being recreated. The stream needs a JSON Schema `description`, and so does every column (file columns and `loaded_at` bring their own); a missing one fails the copy's declaration before any connection reads. The schema must already exist: in the warehouse, `marts` belongs to the reader's contract, and default privileges make the view readable.

A load never replaces or drops an existing view, because replacing a view readers can see would lock them out until the load commits; it only refreshes the comments, which does not block readers. A view of other columns or of another table is refused with an error naming it. A changed stream schema therefore needs a fresh warehouse, as a changed table does.

### Documented Postgres views

`publishPostgresViews(transaction, { schema, views })` from `elt-postgresql` publishes ordinary SQL views with native view and column comments. Each `PostgresView` supplies `name`, `query`, `description`, and a `columns` map from output column names to descriptions. The application defines the SQL and meaning; Postgres derives the output types.

Given a `postgres` client `sql` and an existing `raw.notes` table:

```ts
import { publishPostgresViews } from 'elt-postgresql';

await sql.begin(async (transaction) => {
  await publishPostgresViews(transaction, {
    schema: 'knowledge',
    views: [{
      name: 'notes',
      query: 'SELECT id, title FROM raw.notes',
      description: 'One row per note, identified by id.',
      columns: {
        id: 'Source note identifier.',
        title: 'Note title.',
      },
    }],
  });
});
```

Supply trusted application SQL as one query, with every output column described exactly once and nonempty descriptions. Identifiers follow the destination's 63-byte limit. The publisher creates the target schema if needed, serializes publishing with other writers to that schema, and replaces only the supplied views. List dependencies before their dependents: views are dropped in reverse order and created in the supplied order. Dropping never uses `CASCADE`; an outside dependent prevents publication. A savepoint restores the previous views and comments on any failure, even if the caller catches it and continues the transaction. An empty list does nothing.

The caller owns the connection and transaction. Replacing views recreates them, so reapply explicit grants after publication in that same transaction. Default grants still apply. Applications choose which content to expose; in the warehouse, default privileges on `marts` make every published view readable. `PostgresSyncHistory` uses this publisher for its sync views, and the Search Console marts for their content views.

Views reflect the underlying tables as queried; publishing them does not copy rows or schedule refreshes. Read their descriptions through `obj_description` and `col_description`, just like table comments.

## Apple Messages

```ts
import { Connection, Copy, Pipeline } from 'elt';
import { SQLiteCheckpointStore, SQLiteDestination } from 'elt-sqlite';
import { AppleMessagesSource } from './sources/apple-messages/apple-messages-source.ts';

const source = new AppleMessagesSource(); // ~/Library/Messages/chat.db
const destination = new SQLiteDestination({ path: './outputs/messages.sqlite' });

await new Pipeline({
  connections: [
    new Connection({
      name: 'apple-messages',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({ path: './outputs/messages-state.sqlite' }),
      steps: [source.messages, source.chatMessages].map(
        (stream) =>
          new Copy(stream, destination.table(stream.name), {
            id: stream.name,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
      ),
    }),
  ],
}).run();
```

The source reads Messages' own `chat.db` read-only through `node:sqlite`; Messages.app need not be open. A missing file or a denied grant raises `MessagesUnavailableError` before any copy runs, with the SQLite error as `cause`. `npx nx run apple:start` loads every stream incrementally into the Postgres `apple_messages` schema; each attachment file is saved under `outputs/apple-messages-files` and referenced by `attachmentRef`.

### Full Disk Access

Messages keeps its history only in `~/Library/Messages/chat.db`; it has no public API for reading messages. macOS guards that folder with **Full Disk Access** and checks it against the *responsible* process: the terminal app that runs `npx nx run apple:start`. Grant that app Full Disk Access.

### Streams

Every column of Messages' own tables loads, named in camelCase (`is_from_me` → `isFromMe`); foreign `ROWID`s become the related row's `guid`. Archived Foundation values (binary property lists and `NSKeyedArchiver` graphs) load as JSON text, with data as base64 and dates as ISO timestamps; `attributedBody`, a typedstream, stays base64. Only iCloud sync and task bookkeeping (`deleted_messages`, `sync_*`, `kvtable`, `persistent_tasks`, `message_processing_task`, `index_state_metrics`, `_SqliteDatabaseProperties`) is left out.

| Stream | Key | Contents and relationships |
| --- | --- | --- |
| `chats` | `guid` | All 28 `chat` columns: identifier, service, display name, group id, style, archived and filtered flags, last read time, and `properties` as JSON. |
| `handles` | `id`, `service` | Phone numbers and email addresses per service, with country and person-centric id. |
| `chatLookups` | `identifier`, `domain` | The identifiers Messages resolves to each chat, with priority. |
| `chatServices` | `chatGuid`, `service` | Every service a chat runs over. |
| `chatHandles` | `chatGuid`, `handleId`, `handleService` | Participants of each chat. |
| `messages` | `guid` | All 92 `message` columns plus the sender and other handle (`handle`, `handleService`, `otherHandle`, `otherHandleService`): text, direction, sent/read/delivered/edited/unsent/played/recovered times, reactions, replies, effects and flags; `messageSummaryInfo` and `payloadData` as JSON, `attributedBody` as base64. |
| `chatMessages` | `chatGuid`, `messageGuid` | Which chat each message belongs to, with the join's `messageDate`. |
| `linkPreviews` | `messageGuid` | The rich link a URL message shows, from its `payloadData` archive: `url`, `originalUrl`, `title`, `summary`, `siteName`, `itemType`, `creator`, and the whole `LPLinkMetadata` as JSON. |
| `messageEdits` | `messageGuid`, `partIndex`, `version` | Every version of an edited message part, oldest first, from `messageSummaryInfo.ec`: `editedAt`, the decoded `text`, and the raw entry as JSON. Version 0 is the original. |
| `recoverableMessages` | `chatGuid`, `messageGuid` | Recently Deleted: the chat a deleted message came from and its `deleteDate`. Messages keeps the row in `messages` but removes it from `chatMessages`. |
| `recoverableMessageParts` | `chatGuid`, `messageGuid`, `partIndex` | Deleted parts of a message, with `partText`. |
| `attachments` | `guid` | All 23 `attachment` columns (path, transfer name, MIME type, UTI, size, dates, flags, archived info as JSON) and `availableLocally`. Supports file reads. |
| `messageAttachments` | `messageGuid`, `attachmentGuid` | Which message carries each attachment. |

- **Consistency:** every stream in a run reads through one [read context](#read-context), a read transaction on `chat.db`. The database runs in WAL mode, so all streams see one snapshot however Messages writes meanwhile.
- **Identity:** rows and relationships use `guid`s. `ROWID`s are local and change when Messages in iCloud rebuilds the database.
- **Incremental:** all thirteen are [snapshot streams](#snapshot-streams). Edits, unsends and read receipts change old rows and chat.db has no modification column, so each run scans every row, loads the changed ones, and deletes rows that disappeared.
- **Text:** recent macOS versions store the body only in `attributedBody`, an `NSAttributedString` in typedstream form. `text` falls back to its first string, and the archived value is kept verbatim.
- **Edits:** `date_edited` is not a reliable edit marker; Messages left it empty on edited messages in the verified history. `messageEdits` reads the edit history itself.
- **Times:** chat.db counts from 2001-01-01 UTC, in nanoseconds for message dates and in seconds for attachment dates, edit entries and older histories. Both become UTC timestamps; `0` becomes null.
- **Attachments:** a file is read from its original path, never copied to staging. `MacOSDocumentParser` gives each kind its text: documents convert, images (including files without an extension, identified by their bytes) go through Vision text recognition, contact and location cards load as their vCard text, and voice messages and video load null. A file offloaded to iCloud has `availableLocally: false` and null file fields; no public API downloads it, but when Messages does, the flag changes and the next run loads its bytes and text.
- **Watching:** Messages writes through a WAL it keeps open, and FSEvents reports such a file only when it closes, so `observe()` polls `PRAGMA data_version` on its own read-only connection (every `pollIntervalMs`, default 1000). Every commit, including an attachment finishing its download, changes it.

Live verification on **2026-09-25** (macOS 26.6.2, Node.js 26.8.1), running the exporter as a launchd job for a `node` binary granted Full Disk Access, against a history of 12,567 messages, 468 chats, 472 handles and 41 attachments. Probes read schema, counts and aggregates only; no message content left the machine or entered the repository. The test fixture uses the captured table definitions with synthetic rows, and its archives are encoded by `plutil` and `NSKeyedArchiver`.

- **Schema:** every column of the eleven tables is exported, checked against `PRAGMA table_info`. `handle` is `UNIQUE (id, service)`, `chat_lookup` `UNIQUE (identifier, domain)`, `chat_service` `UNIQUE (service, chat)`; `guid`s have no duplicates; the flags read as non-null booleans have no nulls.
- **Access:** a read-only open works while Messages holds the WAL (`chat.db` 34.8 MB, `-wal` 424 KB).
- **Text:** 11,435 messages (91%) store their body only in `attributedBody`. All 12,567 archived bodies decode, and in the 1,132 rows that also have `text` the decoded string matches it exactly.
- **Archives:** every stored archive is a binary property list (12,545 `message_summary_info`, 24 `payload_data`, 212 chat `properties`, attachment info) and decodes; `plutil` agrees with the decoder on a real key containing a control character (`cmmS\u0010`).
- **Edits:** 3 messages carry an edit history, 2 versions each, although their `date_edited` is null; version 0's time equals the message's `date`.
- **Link previews:** 22, all with URL, original URL and title; 16 with a summary, 17 with a site name.
- **Times:** message times are nanoseconds (2017 to 2026); attachment `created_date` and edit times are seconds. All convert.
- **Runs:** every stream loads in about 1 s without attachment parsing and 5.5 s with it; a second run writes nothing, and another session's five further runs wrote nothing either. Every join and Recently Deleted row references a loaded message, chat and attachment. Snapshot state is about 2.6 MB of JSON.
- **Recently Deleted:** 3 messages, each loaded with its chat in `recoverableMessages`. 88 other messages belong to no chat and load without one.
- **Attachments:** 6 are on disk and 32 offloaded to iCloud; the stored chunks of the 6 total 702,104 bytes, their exact `totalBytes`. They are group photos and link-preview images; Vision found text in one.

## Apple Mail

`AppleMailSource(mailDirectory)` reads the current version under `~/Library/Mail`, located from `PersistenceInfo.plist`, with one read-only `Envelope Index` transaction per run. Pass another Mail root to read a copied store. The identity covers that whole local store; native keys already span accounts. Metadata discovery performs no I/O.

All 42 streams are available as properties and through `discover()`:

| Streams | Data |
| --- | --- |
| `accounts`, `smtpServers` | Non-secret native account/server settings as JSON; local On My Mac identity comes from mailbox URLs |
| `mailboxes`, `mailboxProperties` | Index mailbox URLs, counts and native IDs; `.mbox/Info.plist` properties |
| `messages`, `subjects`, `summaries`, `generatedSummaries` | Every native message column, subject/summary dictionaries and generated summary payloads |
| `addresses`, `recipients` | Address/comment dictionary and positioned recipient relationships, including orphaned native rows |
| `messageMailboxes`, `serverMessages`, `serverMessageMailboxes` | Local and server mailbox memberships, message state, IMAP identifiers |
| `conversations`, `conversationMessages`, `messageReferences`, `messageGlobalData` | Conversation membership, reply references, global message status and deferred-action metadata |
| `messageMetadata`, `dataDetectionResults`, `richLinks`, `messageRichLinks`, `protectedMessageData` | Native JSON, detected values, links and opaque protected payloads |
| `brandIndicators`, `brandIndicatorEvidence`, `addressMetadata`, `businesses`, `businessAddresses`, `businessCategories`, `senders`, `senderAddresses`, `events` | Brand/certificate blobs, sender classification, business metadata, S/MIME capabilities and detected event metadata |
| `rules`, `ruleConditions` | Synced/local rules, active flags, ordered conditions and original property dictionaries |
| `smartMailboxes`, `smartMailboxConditions` | Saved hierarchy, ordered criteria and original property dictionaries |
| `signatures`, `configuration` | MIME signature content and MailData/signature property lists |
| `messageFiles` | One row per indexed message, relative path, local availability, partial flag, size, SHA-256, original EMLX file |
| `messageHeaders` | Ordered headers for every MIME part; unfolded/decoded value and original header-line bytes in base64 |
| `messageParts` | MIME tree, media type, charset, disposition, filename, content ID, local availability, size, SHA-256 and decoded text for `text/*` parts |
| `attachments`, `indexedAttachments` | Decoded MIME attachments plus indexed attachments whose MIME has not arrived; native attachment-index rows remain separately available |

Index column names become camel case; `ROWID` becomes `id`. Integer identities and hashes export as decimal strings to preserve 64-bit precision. `messages.id` is the local row ID used by `attachments.messageId`, `messageParts.messageId` and `messageFiles.messageId`; `messages.messageId` is Apple's distinct RFC Message-ID hash. `messageGlobalData.messageId`, `conversationMessages.messageId` and `messageReferences.reference` use that hash. Mailbox URL hosts identify account directories. Keep native multiple-mailbox relationships instead of assuming one folder per message.

Confirmed Unix timestamps become UTC ISO strings. Unconfirmed native date fields retain their numeric value with a `Raw` suffix; nulls stay null. Blob columns become base64 strings. Configuration and opaque native payloads are preserved without guessing undocumented meanings. Passwords, authentication internals, transient queues, derived search indexes and remote-content caches are outside the user-content export.

MIME structure and transfer decoding use `@zone-eu/mailsplit`'s public `Splitter`/`MimeNode.getDecoder()` APIs; `libmime` decodes encoded header words. Apple-specific code reads only the EMLX byte frame and resolves detached downloads. Nested `message/rfc822` attachments remain complete decoded files. The multipart root is `TEXT`, children use dotted MIME part numbers, and a single-part message uses `1`, matching Apple's index before its file arrives. Attachment keys survive later downloads. Full MIME, inline images, calendar invitations, archives, arbitrary binary files and attached messages all retain bytes regardless of text-parser support. The shared document parser returns null for unsupported text extraction.

Each file stays readable while the consumer uses it. Attachment decoding streams into disposable run storage and releases each message after consumption; body text decodes directly into its record without a temporary file. Header-only reads do not decode bodies. Each selected MIME stream rereads the pinned files; temporary content is bounded by one message rather than the archive. Original EMLX files are hashed and checked before/after reading; file replacement or disappearance during a scan fails the stream rather than committing a misleading snapshot. Missing files at the start are recorded as unavailable. Orphan EMLX files absent from the live index are not messages.

Copies use `incremental`, `append_dedup`, the stream's entire primary key and no cursor field. Every run scans all selected records and lists every selected message. `messageFiles`, `messageHeaders`, `messageParts` and `attachments` are [grouped snapshots](#snapshot-streams) with one group per message. A group's fingerprint covers the parser version, the `.emlx` path and stat (device, inode, size, and modification and change times in nanoseconds), the stat of each detached file, and the message's rows in the index's `attachments` table. A message whose fingerprint is unchanged keeps its saved rows without being read, so a run parses only new and changed messages. Selection still runs on every pass: a message that leaves the scope has no group and its rows are deleted. Raise `messageParserVersion` when parsing or these streams' records change, so every message is read again. There are no date, message-count or file-size windows. Changes to flags, membership, bytes and availability update rows; vanished keys emit deletes; an unchanged snapshot writes zero rows. Scan time and checkpoint size grow with the archive; temporary MIME disk grows with the largest message. Destination staging and original-byte storage need additional disk space. SQLite is transactionally consistent, but Mail's filesystem/settings are separate: concurrent changes can fail a stream and require another run.

Watching subscribes to the Mail directory recursively and checks `PRAGMA data_version` every second. It invalidates selected streams on commits or file changes, including attachment downloads that do not change the index, and closes both handles on cancellation/iterator return. It observes Mail's local activity; leave Mail running and syncing for remote changes. Reading account settings uses Mail's scripting API and may launch Mail. A changed Mail version directory requires restarting the watch.

Full Disk Access is required for the exporting process; `accounts` and `smtpServers` also require Automation access to Mail. A missing/inaccessible store raises `MailUnavailableError`; unknown required index columns raise `MailSchemaError`; files changing during a read raise `MailChangingError`. Errors preserve their causes. A pipeline reports failures per stream and retains its prior committed data/checkpoint.

Live probing on 2026-09-26, macOS 26.6.2 (Mail V10), examined the entire local archive: 25,253 EMLX files at the initial inventory (8,533 full and 16,720 partial), 536 detached files, three indexed messages without local files and sixteen orphan EMLX files. Multiple mailbox membership, 64-bit hashes, both IMAP/iCloud account identities, rule flags, nested smart mailboxes and native timestamp units were inspected. The Mail scripting `authentication` property fails for iCloud, so it is not read. MailKit provides extension callbacks rather than historical bulk extraction; scripting per-message reads would cross the process boundary for the whole archive, so the native read-only store supplies content.

### Mail implementation verification

The access-method review selected the read-only index, EMLX and plist files for local history, with the scripting dictionary only for account settings. Manual mailbox export loses index relationships and cannot supply incremental change signals. IMAP/provider APIs describe remote accounts, not this Mac's local folders or downloaded state. MailKit needs an installed extension and offers delivery callbacks, not a historical archive reader. No public native framework supplies all historical Mail records. Native filesystem notifications plus SQLite commit detection cover both file-only downloads and metadata edits; polling scripting objects would repeatedly cross process boundaries.

Checks on 2026-09-26 used Node.js 26.8.1 and macOS 26.6.2:

- `npx nx run apple:typecheck` and `npx nx run elt-sqlite:typecheck` pass. `apple:test` passes all 60 tests; `elt-sqlite:test` passes all 31. The initial Apple baseline passed 56 tests.
- Four Mail integration tests import `AppleMailSource` directly and load through real Pipeline/SQLite/Markdown destinations. They cover all 42 streams, exact file bytes, nested MIME, repeated/empty/encoded headers, 64-bit IDs, missing and later-downloaded content, changed flags/memberships, deletion, unchanged reruns, schema/read failures, checkpoint preservation, filesystem/index watch notifications and cancellation. Fixtures contain only synthetic data and Apple's schema, never personal records.
- Native ImageIO/Vision checks cover 1-, 2- and 3-pixel images through the Mail attachment pipeline. Smaller tracking pixels return null text while retaining their original bytes. Existing PDF, text, image and extensionless HEIC checks pass. Backlog defect #2038 is closed.
- A full live attachment copy without a text parser loaded 1,152 records: 576 locally available files totaling 122,303,823 bytes in 583 SQLite chunks, and 576 unavailable records. Its unchanged second run wrote zero records and zero deletions.
- Mail verification through the Apple exporter completed 40 of 42 streams, loading 25,689 messages, 819,179 headers and 69,324 MIME parts, including 46,251 text parts (1,133,028,667 UTF-8 bytes). All 25,689 stored original EMLX files (1,379,197,940 bytes) were reassembled and verified against their source SHA-256 and size on 2026-09-27. Forty checkpoints committed. The full body snapshot succeeded after changing SQLite to sort only row identifiers; earlier whole-payload sorting exhausted temporary disk on this nearly full Mac. The subsequent entry-point run completed 39 streams: 38 wrote nothing (including messages, EMLX files and headers), and two mailbox-property rows updated. Mail changed EMLX files during the later body and attachment scans, so those streams failed without advancing their saved checkpoints. Repeated native reads of all 33 mailbox plists had stable values/key order and matched the saved export; the mailbox updates were not generated serialization differences.
- A native temporary mbox import appeared through `Pipeline.watch()`, and its read/flag changes reached SQLite. Deletion and signature persistence could not be completed: Mail's delete AppleEvent failed with `-10000`, a subsequent message deletion crashed Mail with `-609`, and the locked Mac prevented UI cleanup. The temporary signature was removed through the scripting API and its native count was zero. The one-message local mailbox `Import/ContextCompiler-Mail-Probe-20260926` still needs UI removal after unlocking. No message was sent.
- The complete configuration stream encounters a denied `MailData/recentSearches.plist` (`EPERM`, also reproduced with native `plutil`); a changing `SyncedFilesInfo.plist` can fail it sooner. The default attachment text copy encounters a corrupt local PDF at message `5597`, part `4`: the detached file starts inside document metadata rather than with a PDF header, and PDFKit rejects it. These errors are preserved; the byte-only copy above proves attachment extraction independently of text parsing.

The `remove-code` review retained the Apple-specific frame, detached-file lookup, schema validation and file-change checks: no adopted API handles those requirements. It adopted public `Splitter`, `MimeNode.getDecoder()`, `Headers.getList()/getFirst()`, `libmime.decodeHeader()/decodeWords()`, Node streams/TextDecoder/disposable stacks, native `plutil`, and the existing plist decoder, snapshot diff and pipeline. Package export/type/runtime and debug-hook searches found no built-in EMLX reader or archive observation hook. The measured call sites are one source caller each for `readMailMime` and `MailStore.open`, one destination factory for `SQLiteDeduplicatingWriter`, and four parser constructors across the exporter and public integration tests. Public exports and documentation remain because callers also exist outside this repository.

- **Removed:** the new archive-wide MIME cache and body staging, replaced by a per-message read using native stream decoding; the exact-byte, body, unchanged-rerun and error tests pass. Disposable stacks own resources; a redundant constructor cleanup catch and duplicate text-decoder setup were removed. SQLite now ranks staged row IDs instead of entire payloads, fetching winning rows by primary key; its sequential-operation equivalence tests pass. A native transaction-rollback test proves that the original error and previously committed rows survive.
- **Net delta:** 2,515 lines added and 39 deleted (+2,476), including all five new source/platform/test files, dependency manifests, exports, documentation, default exporter registration and the small SQLite correction. This is additive because it introduces the 42-stream connector and its synthetic native-store integration tests. Counts exclude the pre-existing engine/destination work and earlier skill relocation; completed temporary probe scripts and package extracts were removed.
- **Retained:** the source and platform readers, declarative native table schema, public integration tests, README/reference and dependency declarations. These provide the requested connector, native format boundary, API and reproducible checks. No separate connector cache, scheduler, migration or compatibility path remains.
- **REJECTED:** high-level `mailparser` hides stable MIME part paths; mailsplit's `Streamer` can transform flowed text, so it cannot guarantee original attachment bytes. `Headers.getDecoded()` drops empty values and does not decode encoded words; the ordered public header list plus `libmime` preserves both. Per-message AppleScript and MailKit do not meet the local bulk-history requirement.
- **Self-audit:** no added compatibility branch, suppression directive, guessed native date epoch or catch-and-empty fallback remains. Nullable MIME values correspond to `mime-node.js` lines 150–163 (`false` for unavailable parsed values) and `headers.js` lines 90–100 (empty string for an absent header). Mailsplit owns missing Content-Type inference (lines 122–143); TextDecoder owns its charset default. Missing downloaded files/plists are observed upstream states, while failed reads throw. Null account-cache initialization only shares one native call per run. The source path is explicit.
- **Unproven/unresolved:** live deletion/signature persistence and a completely successful default run remain limited by the specific native Mail, access and corrupt-file failures above. A quiet full-body rerun was prevented by Mail changing files during the repeat scan; the earlier full body export succeeded and the prior checkpoint survived this failure. Synthetic tests cover these stream contracts; they do not establish the blocked native behavior. The UI cleanup request is pending until the Mac is unlocked.

- [x] Probing: access methods and change signals reviewed, full-archive live checks run.
- [x] Source written with snapshot incremental sync and deletions.
- [x] Black-box tests through source classes and real destinations.
- [x] README and reference updated.
- [x] Gotchas checked: failed reads throw, keys are unique, fingerprints contain no generated read timestamps, native schemas are detected, and catalog validation stays in the base source.
- [ ] Fully green real-upstream run and native CRUD cleanup: blocked by the explicitly recorded Mail failures and locked session. The parser defect is closed; no open Mail backlog item replaces these checks.

## Apple Contacts

```ts
import { Connection, Copy, Pipeline } from 'elt';
import { SQLiteCheckpointStore, SQLiteDestination } from 'elt-sqlite';
import { AppleContactsSource } from './sources/apple-contacts/apple-contacts-source.ts';

const source = new AppleContactsSource(); // ~/Library/Application Support/AddressBook
const destination = new SQLiteDestination({ path: './outputs/contacts.sqlite' });

await new Pipeline({
  connections: [
    new Connection({
      name: 'apple-contacts',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({ path: './outputs/contacts-state.sqlite' }),
      steps: [source.contacts, source.phoneNumbers, source.emailAddresses].map(
        (stream) =>
          new Copy(stream, destination.table(stream.name), {
            id: stream.name,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
      ),
    }),
  ],
}).run();
```

The source reads Contacts' own Core Data stores read-only through `node:sqlite`: `AddressBook-v22.abcddb` at the root of `~/Library/Application Support/AddressBook` (On My Mac) and one `Sources/<id>/AddressBook-v22.abcddb` per account. Contacts.app need not be open. A store or the `Sources` folder that cannot be opened (missing, or no permission) raises `ContactsUnavailableError`, and a store without a column the connector reads raises `ContactsSchemaError` naming the columns, both before any copy runs. `npx nx run apple:start` loads every stream incrementally into the Postgres `apple_contacts` schema; each photo is saved under `outputs/apple-contacts-files` and referenced by `attachmentRef`.

### Access

macOS guards the AddressBook folder with the **Contacts** privacy service, and Full Disk Access covers it too; either works, checked against the responsible process: the terminal app that runs `npx nx run apple:start`. Contacts access prompts once for that app; a dismissed prompt is recorded as a denial and never shows again, so enable the app under **System Settings → Privacy & Security → Contacts**, or grant it [Full Disk Access](#full-disk-access).

Contacts.framework is not used. It needs the Contacts grant itself and exposes less than the stores hold.

### Streams

Every stored attribute of the Core Data model (`ABAddressBook`, version `24A2` on macOS 26) loads, named as the model names it (`ZJOBTITLE` → `jobTitle`). Relationships load as the related record's `uniqueId`, which is the Contacts.framework identifier of contacts and groups (`…:ABPerson`, `…:ABGroup`). Property-list data loads as JSON and other data as base64; dates are UTC timestamps. Labels load raw: Apple's constants look like `_$!<Mobile>!$_`, while custom labels and labels written through AppleScript are plain text. Left out are Core Data's own `Z_` columns, transient attributes, values stored only to sort or search (creation and modification year and yearless offsets, `sortingFirstName`, `sortingLastName`, `nameNormalized`, `addressNormalized`, `lastFourDigits`, `ABCDContactIndex`), and sync bookkeeping (`ABCDInfo`, `ABCDDeletedRecordLog`, `CNCDChangeHistoryClient`, `CNCDProviderMetadata`, `CNCDUnifiedContactInfo`, persistent history).

| Stream | Key | Contents and relationships |
| --- | --- | --- |
| `containers` | `id` | One per store: `source` (the `Sources` folder name, null for On My Mac), `type`, `isAll`, `remoteLocation`, `lastSyncDate`, `meContactId` (the account's "my card"), and the record fields every entity shares. |
| `groups` | `id` | `kind` (`group`, `subscribedGroup`, `smartGroup`), `name`, `containerId`, and a smart group's archived query as JSON. |
| `groupMembers` | `groupId`, `contactId` | Which contacts each group holds. |
| `groupSubgroups` | `parentGroupId`, `childGroupId` | Groups nested in groups. |
| `contacts` | `id` | `kind` (`contact`, `subscribedContact`), `containerId`, names and phonetic names, organization, department, job title, `birthdayYear`/`birthdayMonth`/`birthdayDay`, `linkId` (contacts Contacts shows as one), image metadata, `meOfContainerId`, creation and modification times, and sync fields. |
| `notes` | `contactId` | The note's `text` and `richTextData`. |
| `alternateBirthdays` | `contactId` | The non-Gregorian birthday: `calendarIdentifier` (such as `chinese`), `era`, `year`, `month`, `day`, `isLeapMonth`. |
| `phoneNumbers`, `emailAddresses`, `postalAddresses`, `urlAddresses`, `socialProfiles`, `messagingAddresses`, `relatedNames`, `contactDates`, `calendarUris`, `addressingGrammars`, `likenesses` | `id` | Labeled values: `contactId`, `label`, `isPrimary`, `isPrivate`, `orderingIndex`, and each kind's fields. `messagingAddresses.service` is the service's name (`SkypeInstant`, `JabberInstant`); `contactDates` has `year`, `month`, `day`. |
| `alertTones` | `id` | A contact's ringtone or text tone. |
| `customPropertyValues` | `id` | A custom property's value on any record, with the property's `propertyName`, `recordType` and `valueType`. |
| `remoteLocations` | `id` | URLs attached to any record. |
| `unknownProperties` | `recordId`, `propertyName`, `originalLine` | vCard lines Contacts kept without understanding them; the line (base64) is part of the key, and identical lines load once. |
| `distributionListConfigs` | `groupId`, `contactId`, `propertyName` | The email, phone or address a group uses for a member. |
| `images` | `contactId`, `kind` | A contact's `image` and `thumbnail`: `storage` (`inline` or `external`), `externalId`, `byteLength`, `sha256`. Supports file reads. |

- **Consistency:** the [read context](#read-context) opens every store in one read transaction each, so a contact agrees with its phones, groups and photos. Stores commit independently, so two accounts are not pinned to the same instant; no relationship crosses stores.
- **Identity:** `uniqueId`s are UUIDs, unique across stores; `Z_PK`s are local to a store and are never exported. Contacts.framework identifies an account's container as `<source>:ABAccount`, not by the container row's `id`.
- **Dates:** Contacts stores birthdays and dates as noon UTC of the day, in year 1604 when the year is unknown; they load as `year` (null without one), `month` and `day`.
- **Incremental:** all 24 are [snapshot streams](#snapshot-streams). Labeled values carry no modification date and deleted records leave no row; the Core Data persistent history is contactsd's to prune, not a cursor the connector owns. Each run scans every row.
- **Photos:** Core Data keeps a photo inline (`0x01` and the bytes), staged in a temporary file removed once the record is loaded, or in its own file (`0x02` and a UUID) under `.AddressBook-v22_SUPPORT/_EXTERNAL_DATA`, read in place. `sha256` makes a replaced photo a changed record. Other encodings throw. For iCloud contacts the Mac keeps only the thumbnail; the full photo stays in iCloud (`imageReference`), and Contacts.framework reports no image data for them either.
- **Account names:** the stores do not name their accounts; Contacts.framework takes "iCloud" or "Google" from the Accounts framework, which this source does not read. `containers.name` is null.
- **Failures:** a store that cannot be opened stops the run instead of being read as empty, which would delete its account's rows from every target.
- **Watching:** contactsd writes through WALs it keeps open, so `observe()` polls `PRAGMA data_version` on each store, and the `Sources` listing, every `pollIntervalMs` (default 1000). A commit or an added or removed account yields every selected stream.

Live verification on **2026-09-25** (macOS 26.6.2, Node.js 26.8.1) against three stores: On My Mac with 1 contact, iCloud with 3 and Google with 410. Probes read schema, counts and masked value shapes; field values were inspected only on synthetic probe contacts, which were created through Contacts.app scripting and Contacts.framework and deleted afterwards. The test fixture uses the captured table definitions with synthetic rows.

- **Schema:** the model was read from `ContactsPersistence.framework`, confirming which overloaded `ZABCDRECORD` column belongs to which entity (`ZCONTAINER` groups, `ZCONTAINER1` contacts, `ZNAME1` container name) and which data allows external storage (`imageData`, `thumbnailImageData`).
- **Framework agreement:** for all 414 contacts, identifiers, per-contact counts of phones (470), emails (27), postal addresses (53), URLs (4), social profiles (8) and dates (1), exact thumbnail byte lengths and birthday parts equal a non-unified Contacts.framework fetch.
- **Create, edit, delete:** probe contacts with every scriptable field loaded with the values written, including a year-less birthday and date, a Chinese-calendar birthday, custom and constant labels, Jabber and Skype addresses, a note, group membership, nested groups, and inline (37,107 bytes) and external (159,443 bytes) thumbnails. Changing a job title and removing a phone wrote that contact and one deletion. Deleting the probes removed their contacts and every child row.
- **Photos:** 29 in the verified book: 26 thumbnails and 3 full photos, 4 stored externally. A 985 KB photo saved through Contacts.framework on an iCloud contact kept only its thumbnail locally.
- **Runs:** the first run takes 32 s, almost all of it Vision text recognition on the photos; a second run takes 0.13 s and writes nothing. iCloud and Google syncs rewrite group and container modification times, which load as genuine changes, and runs after they settled wrote nothing.
- **Watching:** a live watch loaded a contact saved through Contacts.framework 0.65 s after the save, and its deletion 0.55 s after that.
- **Unverified:** the book holds no smart or subscribed groups, subscribed contacts, calendar URIs, likenesses, alert tones, custom property values, remote locations, unrecognized vCard lines or distribution list choices, so those streams are covered only by the synthetic fixture. Contacts.framework has no way to create them: a synthetic vCard with `CALURI` and an `X-` line, saved through it, stored neither, and the deprecated AddressBook framework's vCard import saved nothing. Smart groups and distribution lists need the Contacts.app interface, and unrecognized lines a vCard import confirmed in Contacts.app; those manual steps were not run. The deprecated AddressBook framework aborted (`SIGABRT`) while writing a custom property value, and cannot remove the property definition it had created, which stays in the iCloud store without values.

## Apple Reminders

```ts
import { Connection, Copy, Pipeline } from 'elt';
import { SQLiteDestination } from 'elt-sqlite';
import { AppleRemindersSource } from './sources/apple-reminders/apple-reminders-source.ts';

const reminders = new AppleRemindersSource();
const sqlite = new SQLiteDestination({ path: './reminders-eventkit.sqlite' });

await new Pipeline({
  connections: [
    new Connection({
      name: 'apple-reminders',
      source: reminders,
      destination: sqlite,
      steps: (await reminders.discover()).streams.map(stream =>
        new Copy(stream, sqlite.table(stream.name)),
      ),
    }),
  ],
}).run();
```

Reminders uses **EventKit exclusively**, through the `eventkit` helper (see [Calendar](#apple-calendar)). It does not use Reminders.app's scripting API, and the app need not be open. macOS 27 and full Reminders permission are required for the process running the export. Enable access in **System Settings > Privacy & Security > Reminders**. Calendar permission and Automation permission do not substitute for it. A sandbox can block access even when permission is granted.

All eight streams support full refresh and [snapshot incremental](#snapshot-streams) and work with inferred SQLite tables or Markdown targets. Discovery and validation perform no native reads or permission requests. The first extraction requests permission if undecided, waiting up to 30 seconds. Denied, restricted, pending, and revoked access throw `RemindersUnavailableError`, retaining the process error as its cause. Asynchronous fetches time out after 60 seconds and cancel the request. A nil fetch result is an error; only a successful empty array can clear a target. Failed reads preserve the previous contents of the affected target. Only macOS 27 is supported, because the helper is built for it.

| Stream | Contents and relationships |
| --- | --- |
| `accounts` | Native EventKit sources: `id`, name, type, delegate flag. May include accounts with no visible reminder lists. |
| `lists` | Native reminder calendars: `id`, `accountId`, name, type, writable/subscribed/immutable flags, sRGB color components, availability and entity masks. |
| `reminders` | Native `id`, `listId`, nullable external identifier, name/body/location/URL, item time zone, nullable creation/modification/completion timestamps, completion flag, priority (0–9). Includes completed and incomplete reminders. |
| `dateComponents` | Up to two rows per reminder, linked by `reminderId`, with `kind` of `start` or `due`. Preserves native date components, calendar identifier, and nullable time zone. |
| `attendees` | Public EventKit participants, when supplied: `reminderId`, position, name/URL, status, role, type, current-user flag. This is not a Reminders sharing/assignment API. |
| `alarms` | `reminderId`, position, type, relative offset, absolute timestamp, email/sound, proximity, location title, latitude/longitude, radius in meters. |
| `recurrenceRules` | `reminderId`, position, calendar identifier, frequency, interval, first weekday, ending date/count. |
| `recurrenceRuleValues` | `reminderId`, `ruleId`, component/position, value and optional weekday ordinal; preserves all six public recurrence selectors. |

Date components preserve undefined values as `null`, including missing clock components for date-only reminders. A null time zone means a floating date/time; it is never silently replaced with UTC. Start, due, and item time zones remain separate. No UTC due instant is invented from a date-only or floating reminder. Native timestamp properties remain UTC ISO strings. Missing start/due properties produce no component row. On macOS 26.6.2, EventKit refused non-Gregorian date-component calendars (`Calendar must be nil or Gregorian`). It also normalized a due time set with only an hour and no calendar: the stored components carried the Gregorian calendar and `minute: 0`. Exports report the components EventKit stores, not the values an app originally assigned.

Native enum values remain integers. Alarm proximity is `0` (none), `1` (arrival), or `2` (departure); a radius of `0` asks the system to choose a radius. Recurrence frequency is `0` (daily), `1` (weekly), `2` (monthly), or `3` (yearly). A zero recurrence count means no count-based limit. Only the next incomplete reminder in a recurring series is exposed by Apple; the source does not invent future occurrences or deliver notifications.

EventKit IDs can change after a full server sync; external identifiers are not universally unique or stable across providers/devices. Child IDs identify positions within the current snapshot; attendees and alarms are numbered in content order (see [Calendar completeness](#completeness-and-limits)). Full-refresh overwrite and snapshot incremental both reconcile deletions; incremental still fetches every reminder each run, because EventKit offers no change feed. Every selected stream comes from one change-free snapshot (see [EventKit consistency](#eventkit-consistency)); the destination still commits each stream on its own, with no pipeline-wide transaction. The helper streams its output with no size cap or process timeout.

See the [EventKit research and implementation notes](eventkit-reminders.md) for API evidence, design choices, and verification.

## Apple Calendar

```ts
import { mkdir } from 'node:fs/promises';
import { Connection, Copy, Pipeline } from 'elt';
import { SQLiteDestination } from 'elt-sqlite';
import { AppleCalendarSource } from './sources/apple-calendar/apple-calendar-source.ts';

await mkdir('./outputs', { recursive: true });
const calendar = new AppleCalendarSource({
  startAt: '2026-09-01T00:00:00.000Z',
  endAt: '2026-10-01T00:00:00.000Z',
});
const sqlite = new SQLiteDestination({ path: './outputs/apple-calendar.sqlite' });

await new Pipeline({
  connections: [
    new Connection({
      name: 'apple-calendar',
      source: calendar,
      destination: sqlite,
      steps: (await calendar.discover()).streams.map(stream =>
        new Copy(stream, sqlite.table(stream.name)),
      ),
    }),
  ],
}).run();
```

Calendar reads EventKit through `eventkit`, a compiled Swift helper ([platform/macos/eventkit](../apps/apple/src/platform/macos/eventkit)). The Nx target `apple:eventkit` builds it as a universal (arm64 and x86_64) binary into `apps/apple/dist/platform/macos/eventkit`; `apple:plugin` copies it next to the plugin's `server.mjs`. `eventkit read '<json request>'` writes one JSON document per line (account, calendar, occurrence, ICS export, reminder), and `eventkit watch events|reminders` prints `changed` per store change. One read runs one helper process for every selected stream. The helper reports EventKit's values; the source builds the rows: IDs, ISO timestamps, content-order positions, and scope filtering. macOS attributes access to the app responsible for the process: the terminal, or Codex for the plugin.

Calendar needs macOS 27 and full Calendar access for the process running the export. The first extraction requests access if it is undecided or write-only, through `osascript` (macOS shows no prompt for the helper's own request), waiting up to 30 seconds; the grant goes to the terminal or app running the export. If permission is denied, restricted, or still pending, the helper reports `CALENDAR_UNAVAILABLE` and `CalendarUnavailableError` preserves the native cause and explains how to enable access. A sandbox can block access even when macOS permission is granted. Permission failures never become empty successful exports.

The `calendars` stream's `description` is EKCalendar's private `notes` property, the description Calendar.app shows; a calendar without one exports an empty string. The helper checks for the property and fails the read when a macOS version lacks it. Calendar needs no Automation access and never launches Calendar.app.

The `icsComponents`, `icsProperties`, and `icsParameters` streams read each item's iCalendar export through **private** EventKit API (`EKEventStore` `ICSDataForCalendarItems:preventLineFolding:`, falling back to `:options:`). The helper exports each item once, and only when an ICS stream is selected. It checks for the method first: when a macOS version lacks it, the copy fails with `CalendarIcsUnavailableError` rather than exporting nothing, and an export without any event component fails too. A macOS update can remove or change this API; select only the public streams if that matters more than ICS coverage.

### Streams

All eleven streams support full refresh and snapshot incremental (`append_dedup` keyed by `id`, no `cursorField`; see [snapshot streams](#snapshot-streams)) and work with inferred SQLite tables or Markdown targets. Related collections are separate scalar rows, preserving their data without adding JSON columns to SQLite.

| Stream | Contents and relationships |
| --- | --- |
| `accounts` | EventKit sources: identifier, name, native source type, delegate flag. |
| `calendars` | Identifier, `accountId`, name, description, native type, write/subscription/immutability flags, sRGB components, supported availability and entity masks. |
| `events` | Expanded occurrences: native identifiers, `calendarId`, title/body/location/URL, start/end, all-day dates, time zone, creation/modification dates, original occurrence date, detached flag, status/availability, birthday contact identifier, geographic location. |
| `attendees` | `eventId`, position, participant name/URL, native status/role/type, current-user flag. `kind` distinguishes attendees from the organizer. |
| `alarms` | `eventId`, position, native alarm type, relative offset in seconds, absolute date, email/sound, proximity and geographic location. |
| `recurrenceRules` | `eventId`, position, calendar identifier, frequency, interval, first weekday, end date and occurrence count. |
| `recurrenceRuleValues` | `ruleId`, `eventId`, component and position, integer value, optional weekday ordinal. Preserves weekdays, month/year days, year weeks, months, and set positions. |
| `icsComponents` | One row per iCalendar component of a native item (`VCALENDAR`, `VEVENT`, `VALARM`, `VTIMEZONE`, …): `id` `[calendarId, calendarItemId, path]`, `parentId`, `position`, `name`, `uid`, the raw `recurrenceId` with its `recurrenceIdTimeZone` (TZID), and `eventId` when it is exact (the master of a non-recurring event). |
| `icsProperties` | Every property except `DTSTAMP`, with its raw value: `componentId`, `position`, `name`, `value`. Includes `ATTACH`, `RRULE`, `EXDATE`, `RECURRENCE-ID`, `URL`, and vendor properties such as `X-GOOGLE-CONFERENCE` and `X-MICROSOFT-*`. |
| `icsAttachments` | One row per `ATTACH`: `uri` (raw), `filename` (`X-APPLE-FILENAME` or `FILENAME`), `formatType` (`FMTTYPE`), `inline`. Supports file transfer: inline base64 content is decoded locally; remote references are downloaded by the `attachments` fetcher given to `AppleCalendarSource`, and a file the fetcher reports as unreachable loads as `null`. |
| `icsParameters` | One row per parameter value: `propertyId`, `componentId`, `position`, `valuePosition`, `name`, `value` (for example `ATTACH;FMTTYPE`, `ATTACH;FILENAME`, `DTSTART;TZID`). |

Native enums and bitmasks remain integers. Missing optional values remain `null`; zero recurrence count means no count-based limit. Schema details are available on each stream's `jsonSchema`.

### Dates and occurrence identity

The required bounds are canonical UTC ISO timestamps with `startAt < endAt`. They select the half-open interval `[startAt, endAt)`: overlapping events are included; a zero-duration event is included when its start lies in the interval. The range is not part of the source identity (`apple-calendar:eventkit`), so an incremental copy can move its window between runs: occurrences that leave it are deleted. Construction, discovery, and preflight perform no native reads.

EventKit expands recurrence and applies deleted/rescheduled occurrence exceptions. The helper queries in windows of at most 365 days, inside one process, to avoid EventKit's silent four-year query truncation; an occurrence that spans windows loads once. An unbounded export is not supported because a repeating series may have no end.

`startAt`, `endAt`, and other timestamps retain native instants as UTC strings. For all-day events, `startDate` and `endDate` separately preserve the local Gregorian dates in EventKit's default time zone. `endDate` is **inclusive**: it is the event's last day. EventKit stores an all-day event as ending one second before the next local midnight. A live probe on **2026-09-24** (macOS 26.6.2, Asia/Amman) saved a one-day and a two-day all-day event from 25 September. They exported `endAt` `2026-09-25T20:59:59.000Z` with `endDate` `2026-09-25`, and `2026-09-26T20:59:59.000Z` with `endDate` `2026-09-26`. Both events had a null `timeZone`. The probe deleted both events and confirmed their removal with a fresh read. To get a half-open range, add one day to `endDate`. A null `timeZone` remains null; it is not replaced with UTC. Timed events have null date-only fields.

The event `id` (also exposed as `eventId`) combines the calendar identifier, local calendar-item identifier, and the original occurrence date for repeating/detached events. It uses the native original date rather than the rescheduled start; all-day occurrence keys use a calendar date. Native event and external identifiers remain separate fields. EventKit identifiers can change after moves or full server syncs, so these are local extraction identities, not permanent cross-device IDs. Child IDs add the collection kind/component and position; they identify snapshot rows, not independently stable native objects.

Per-item recurrence metadata comes from the ICS streams: each native item's `UID`, `SEQUENCE`, raw `RRULE` and `EXDATE` are `icsProperties` rows (an `EXDATE`'s `TZID` is an `icsParameters` row), and a detached item's `VEVENT` carries its series `UID` with a `RECURRENCE-ID`. The structured rules are also in `recurrenceRules` and `recurrenceRuleValues` through public EventKit. Each native item's iCalendar data is exported once per read, without paging.

Calendar's scripting interface is not read. A live comparison on **2026-09-25** (macOS 26.6.2) over 2,786 native items from 2000-01-01 to 2027-09-25 found that its event properties added nothing the ICS export lacks: its UID is EventKit's `calendarItemIdentifier` (the series' for the 140 detached items), its recurrence string re-serializes the same rule (adding `INTERVAL=1`, changing `WKST`), its sequence matched `SEQUENCE`, and its excluded dates covered 67 series where `EXDATE` covered 127. It cost about 55 ms per event for each property, batched or not: 17 minutes for six properties of 3,337 events, against about 35 seconds for the ICS export.

Markdown uses the same source; for example, `new Copy(calendar.events, markdown.folder('events', { title: 'name' }))`. Use lowercase target names such as `recurrence-rules` for camel-cased streams.

### Completeness and limits

Full-refresh overwrite and snapshot incremental both reconcile deletions and events moved outside the selected window on the next successful run; incremental writes only the rows that changed. Ordinary append retains observations. Child rows are keyed by position in content order, not EventKit's order: EventKit returns an item's attendees and alarms, and its ICS export an item's sibling components (a series' exceptions and their alarms), in a different order in each process. A live check on **2026-09-25** (macOS 26.6.2) found two runs minutes apart with no edits rewriting 2,600 attendee, 684 alarm and 1,294 ICS component rows, each event's set identical and only reordered; property and parameter order was stable. Attendees are ordered by URL, name, role and type (not status, so a reply updates its row in place), alarms by all their fields, and ICS components by their content. Adding or editing a child can renumber its siblings. Every selected stream comes from one change-free snapshot (see [EventKit consistency](#eventkit-consistency)), so relationships between streams agree; the destination still commits each stream on its own. The helper streams its output with no size cap or timeout. Duplicate tracking retains occurrence/child IDs for the duration of one copy.

The source preserves the EventKit fields above. These remaining capabilities require more than another source field:

- **Change feed:** EventKit provides change notifications but no durable change cursor, so every incremental run still reads the whole window.
- **Attachment bytes and travel time:** attachment files load only through the `attachments` fetcher, because exported references need provider authorization. `googleCalendarAttachments(requester)` downloads Drive files (native Google files as PDF, shortcuts followed, link-shared files with their resource key) and Gmail attachment references, given a `google-auth` requester with Drive and Gmail read scopes. It resolves false for other URLs and for files the account cannot open, including Google files too large to export as PDF (10 MB); rate limits and configuration errors reject. Travel time is not exported. Deprecated open-file alarm URLs are unavailable on modern macOS.
- **Resumable large exports:** these need additional extraction and checkpoint support. Full refresh currently restarts a failed copy, preserving its previous destination contents until the complete replacement succeeds.

See Apple's [EventKit retrieval documentation](https://developer.apple.com/documentation/eventkit/retrieving-events-and-reminders), [occurrence identity](https://developer.apple.com/documentation/eventkit/ekevent/occurrencedate), and [calendar-item identity caveats](https://developer.apple.com/documentation/eventkit/ekcalendaritem/calendaritemidentifier).

### Calendar export probe

A read-only probe on macOS 26.6.2 (2026-09-21) checked Calendar's **File > Export** output:

- **`.ics`:** the sample preserved raw recurrence rules, excluded dates, recurrence IDs, five attachment references, and Google/Microsoft conference properties. It contained no embedded attachment bytes; three references were HTTPS URLs and two were relative query references requiring provider context.
- **`.icbu`:** the archive contained `Calendar.sqlitedb` and `Info.plist`. Its five attachment records had no local file paths or embedded payloads. The database included travel-time columns, but every sampled value was null, so travel-time preservation remains unverified.

These GUI exports are not used. The ICS streams read the same iCalendar data per item through EventKit instead. The archive's private database schema is not a stable public API. Personal probe exports were temporary and are not repository fixtures.

### Attachment files

`icsAttachments` reads attachment bytes only when the target asks for them, and remote references need a fetcher. For Google calendars, the Apple app's `googleCalendarAttachments` downloads Drive files (native Docs, Sheets and Slides as PDF, shortcuts followed to their target, link-shared files with their resource key) and Gmail message attachments. It needs a `googleSession` from `google-auth` whose grant has `drive.readonly` and `gmail.readonly`, from an OAuth client whose project enables the Drive and Gmail APIs. A 403 loads the file as null only when Drive or Gmail says the account may not open it; a rate limit, a disabled API or a missing scope fails the copy, which resumes next run. `npx nx run apple:start` wires it up this way:

```ts
const requester = await googleSession({
  clientId, clientSecret,
  scopes: [GOOGLE_DRIVE_READONLY_SCOPE, GMAIL_READONLY_SCOPE],
});
const calendar = new AppleCalendarSource({
  startAt, endAt,
  attachments: googleCalendarAttachments(requester),
});
new Copy(calendar.icsAttachments, sqlite.table('attachments', (c) => [
  c.text('uri'), c.text('filename'),
  c.blob('bytes').from(calendar.icsAttachments.file),
]));
```

A Drive file the account cannot open (HTTP 404, or a 403 that is not a configuration error) loads with a `null` file. A disabled API, a missing scope, or any other failure fails the copy.

### ICS export verification

On **2026-09-24** (macOS 26.6.2, Asia/Amman) read-only probes exported every item within ±180 days (960 items) and printed only property names and counts:

- Both private selectors exist. No export was empty, and the largest item was 92 KB.
- Every detached item's export carries its own `RECURRENCE-ID` with `TZID`; a recurring master's export can also include its override `VEVENT`s.
- Vendor properties arrive intact: `X-GOOGLE-CONFERENCE` (33 events), `X-GOOGLE-CALENDAR-CONTENT-TITLE`, `X-MICROSOFT-CDO-*`, and `X-APPLE-STRUCTURED-LOCATION` with its parameters. No `ATTACH` occurred in that window. A second probe walked the whole history (2005–2030 in three-year windows, 3,286 items) and found 4 items carrying 5 `ATTACH` properties from 2021–2023. Reading those days through `AppleCalendarSource` loaded all 5 as `icsProperties` rows with 13 `icsParameters` rows: 3 `FMTTYPE`, 5 `VALUE=URI` and 5 `X-APPLE-FILENAME`. Three values are HTTPS URLs and two are relative references that need provider context, matching the GUI export above. None carried inline bytes. Downloading them on **2026-09-24** through `googleCalendarAttachments`, with one account (the calendars' own) and a Desktop client of the project that enables Search Console, Drive and Gmail:

- Both Gmail references downloaded byte-for-byte. A 102,262-byte PNG and a 115,390-byte PDF matched the Gmail message parts' sizes and file signatures, confirming that `attid=0.N…` maps to part `N…` of message `th`.
- The three Drive references returned 404 for the account. Its Drive, including trash and shared drives, held no file with any of their names, so the files had been deleted. They loaded as rows with a `null` file.
- Exporting the same items from two processes three seconds apart changed only `DTSTAMP`, for all 280 events, and never the structure. `DTSTAMP` is the export time, so the streams omit it.

A live run then saved a temporary weekly event with a URL, a location and an alarm, and detached its second occurrence. It ran `events` plus the three ICS streams incrementally into SQLite:

- The first run loaded everything.
- The second run, with no changes, wrote nothing in any stream.
- After the probe was deleted, the next run removed its three occurrences and all of its ICS rows. A fresh EventKit read confirmed the events were gone.

That last run also rewrote 48 component rows of other items. Four later no-change passes, 15 seconds apart, wrote nothing, so this is attributed to concurrent calendar activity rather than to the export; the cause was not verified.

## Google Search Console

`SearchConsoleSource` reads one property through the `searchconsole:v1` API. `sites`, `sitemaps` and `searchAnalytics` are served under the original `webmasters/v3` path prefix; URL inspection is served from `v1` on the same host.

Construct it with an authenticated requester from `googleSession` in `google-auth`:

```ts
const requester = await googleSession({
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
});
const source = new SearchConsoleSource({
  requester,
  siteUrls: ['sc-domain:example.com', 'sc-domain:example.org'],
});
```

### Authorization

The app signs in with its own **Desktop-type** OAuth client, whose id and secret come from `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. The read scope is `https://www.googleapis.com/auth/webmasters.readonly`. Search Console authorizes per property; the client's Google Cloud project supplies API quota, so it must have `searchconsole.googleapis.com` enabled.

One-time setup in the Cloud Console (Google has no API for creating Desktop OAuth clients):

1. Configure the OAuth consent screen as External and add the `webmasters.readonly` scope.
2. Set the publishing status to **In production**. An External consent screen in **Testing** is issued refresh tokens that expire after 7 days unless every scope is one of name, email address and user profile, which `webmasters.readonly` is not.
3. Create an OAuth client ID of type **Desktop app** and export its id and secret.

`googleSession` then works like this:

- **First run.** With no stored grant covering the scopes, it listens on `http://127.0.0.1:<random port>/callback`, opens the consent link in the default macOS browser, and waits up to five minutes. Only a redirect carrying the flow's `state` is accepted; any other request gets `400` and the listener keeps waiting.
- **Browser failures.** A failed launch rejects sign-in and closes the callback listener. Other platforms and headless sessions supply `googleSession({ openBrowser })` to handle the consent URL. The library does not print links or errors.
- **Later runs.** The stored grant is reused without a browser. Each access-token refresh is written back before the request that caused it returns.
- **New scopes.** When a later caller needs a scope the grant lacks, consent runs again for the union of old and new scopes, so no earlier permission is dropped.
- **Revoked or expired grants.** When Google refuses the stored refresh token (revoked consent, an expired Testing-mode token, or a Workspace re-authentication demand), consent runs again.

Grants are stored under `${XDG_CONFIG_HOME:-~/.config}/mac-elt/google/` as owner-only (`0600`) JSON files, written through a temporary file and a rename, so a crash leaves the previous grant intact. This is the same protection gcloud gives its own refresh token; the file is not encrypted. File and directory names are SHA-256 hashes, not account ids. To switch Google accounts, delete that directory; the next run asks for consent.

Because a user credential is billed to the project that issued its OAuth client, no quota-project header is needed. The previous gcloud-import path failed with `SERVICE_DISABLED` / `accessNotConfigured` naming `projects/764086051850`, gcloud's own client project, until a quota project was named.

### Streams

| Stream | Extraction | Key | Notes |
| --- | --- | --- | --- |
| `sites` | Full refresh or snapshot | `[siteUrl]` | Properties the grant can read. `siteUnverifiedUser` entries are dropped: Google lists them, but their history cannot be read. |
| `sitemaps` | Full refresh or snapshot | `[siteUrl, path]` | Google's report on each listed sitemap (int64 counts arrive as decimal strings; `lastDownloaded` is null until Google first reads it), plus what this connector read from the file itself: `urlsRead`, or `readError` when it could not be read. |
| `sitemapContents` | Full refresh or snapshot | `[siteUrl, sitemapPath, type]` | The per-content-type rows nested in each sitemap. |
| `searchAnalyticsDaily` | Incremental | `[siteUrl, date, searchType]` | Site-wide totals per day **per report type**, with `searchType` as a column. |
| `searchAnalyticsQueries` | Incremental | `[siteUrl, date, query]` | Per day and query, web results only. |
| `searchAnalyticsPages` | Incremental | `[siteUrl, date, page]` | Per day and page, web results only. |
| `searchAnalyticsCountries` | Full refresh or snapshot | `[siteUrl, country, device]` | Country and device for a trailing `breakdownMonths` window (default 3), stated on each row as `startDate` and `endDate`. No date dimension, so it is diffed as a whole rather than resumed. |
| `urlInspection` | Incremental (rolling) | `[siteUrl, inspectionUrl]` | One request per URL. `inSitemap` and `inSearchAnalytics` say where the URL was found, `inspectedAt` when; `errorStatus` and `errorMessage` are set when Google rejected the URL. |
| `urlInspectionSitemaps` / `urlInspectionReferrers` | Incremental (rolling) | `[siteUrl, inspectionUrl, position]` | The arrays nested in the index status result. |

One source reads several properties. Every stream except `sites` is a [partitioned stream](#partitioned-streams) with `partitionKey: ['siteUrl']`: each property is read with its own checkpoint, every row carries its property in `siteUrl`, and every key starts with it, so all properties share one table per stream. Adding a property backfills its history while the others resume; removing one stops reading it and keeps its rows. `sites` lists what the grant can read, which is the same for every property, so it is not partitioned.

Every read of the snapshot streams returns the complete list, so an incremental copy (`append_dedup` on the stream's key, no `cursorField`) writes only changed rows and deletes the rest; see [snapshot streams](#snapshot-streams). The inspection streams are rolling instead; see [URL inspection and quota](#url-inspection-and-quota).

The example app lists every property in one source, so each table has one [writer](#target-ownership). To add a property, add it to that source's list; a second connection into the same tables is refused.

#### Why the grains are separate

Google withholds rare queries for privacy, and the loss compounds with every dimension added to a request. Measured against one live property over 2026-09-10 to 2026-09-20:

| Request | Rows | Clicks | Impressions |
| --- | --- | --- | --- |
| `['date']` | 11 | 58 | 1986 |
| `['date','query','page','country','device']` | 749 | 37 | 1020 |

A single wide request loses 36% of clicks and 49% of impressions, and no aggregation of it can recover the property's real totals. Each grain is therefore its own stream with its own window: `searchAnalyticsDaily` stays authoritative for totals, and the breakdowns are only comparable within themselves. Google additionally caps a property at 50,000 rows per day per search type and states the API "does not guarantee to return all data rows", so a high-cardinality request receives silent truncation rather than an error.

Consequences for anything querying these tables: average `position` must be weighted by impressions over non-null rows, `ctr` must be recomputed as `SUM(clicks) / SUM(impressions)` rather than averaged, and query or page rows will not sum to the daily totals. The [warehouse marts](#warehouse-marts) build these rules into the columns an agent reads.

#### Projection

- `ApiDataRow.keys` is **positional** against requested `dimensions`; the API never names the columns. A row whose key count disagrees with the request is skipped rather than failing the copy.
- `clicks`, `impressions` and `ctr` are always present, zeros included (live Discover rows report `"clicks":0,"impressions":0,"ctr":0`). `clicks` and `impressions` are integers; a missing or fractional count fails validation.
- Dated grains carry `settled`: false from the page's `firstIncompleteDate` on, while Google may still restate the day. The next incremental run re-reads it and the flag turns true once Google settles it.
- `position` is **nullable**, and absent for a different reason: Discover and Google News report no rank at all, on every row including zero-traffic ones. Loading a missing rank as `0` would claim the best possible position. Verified live: all 380 Discover and all 380 Google News daily rows carry no position.
- Sitemap `warnings`/`errors`/`submitted` are `string/int64` → parsed to integer, non-safe integers rejected.
- `date` is a **PST calendar date**, not an instant (`format: 'date'`).
- The 16-month history window is calendar arithmetic clamped to the end of a shorter month: sixteen months before 31 March is 30 November. Counting 480 days instead drifts by roughly a week and silently drops history.

The report types change which rows exist, so they are part of the source identity (`search-console:<searchTypes>`); the properties are partitions, not identity. The window is not: it moves with the clock, and state resumes it.

### Incremental search analytics

Google revises recent metrics for roughly two to three days. The response metadata reports `firstIncompleteDate`, the first day still being collected, so the connector does not guess a lookback:

- State is `{ date: '<last settled day>' }`.
- A run resumes **at** the saved date rather than after it, so the last settled day is re-read. That re-read is the lookback.
- Requests use `dataState: 'ALL'`, and the checkpoint advances to `firstIncompleteDate` minus one day, or to the end date when the API reports none.
- Rows are paginated by `startRow` at 25000 per page until a short page.

Because `date` is both the cursor and part of the key, each resumable grain requires `dedupPolicy: 'replace'`. With the default guard the restated day would be discarded. `searchAnalyticsDaily` requests one window per report type and keeps the earliest settled boundary across them, because report types settle independently.

### Warehouse marts

The Apple and Google apps load into the PostgreSQL warehouse and install a shared metadata contract. Each source publishes its own content views in `marts`, named after the source. The layout:

```text
warehouse database
├── google_search_console   raw tables and _mac_elt_checkpoints, loaded by elt-postgresql; readers have no access
├── apple_<name>            private raw Apple tables and checkpoints
├── _warehouse              private sync attempts and coverage declarations
├── marts                   documented reader views, one prefix per source
└── public                  revoked from PUBLIC
roles: warehouse (loads, owns the database) · agent_reader (reads marts only)
```

- **Privileges are the barrier.** `agent_reader` has `CONNECT`, `USAGE` on `marts` and `SELECT` on its relations, and nothing else. It has no `TEMP`, no `CREATE`, and no access to raw schemas. Views run with their owner's rights. The role's settings (`default_transaction_read_only`, `statement_timeout 30s`, `search_path = marts`) are only defaults, since a session may change them.
- **Direct PostgreSQL access works.** Use `psql` as `agent_reader`; MCP is optional. The explicitly invoked `query-warehouse` consumer discovers relations and meanings from `marts.catalog`. It reads connected data only on request and does not run pipelines, refresh data or manage connectors. The existing optional MCP container adds its own SQL restrictions.

The reader's contract is provisioned once, with the database: `infra/init/02-marts.sh` runs `infra/init/marts/contract.sql` in the `warehouse` database. It revokes `PUBLIC` access, gives `agent_reader` `CONNECT` and `USAGE` on `marts`, creates `marts` owned by `warehouse`, publishes `catalog`, and sets default privileges so every table and view the `warehouse` role creates in `marts` is readable by `agent_reader`. No application code grants access. Like every init script, it runs when the volume is first created; to apply a changed contract, recreate the volume with `npx nx run infra:reset`. `installSearchConsoleMarts(sql, { raw })` replaces the Search Console views after extraction, once every Search Console raw table exists; a missing one is named and nothing is replaced. Publication fails if outside views depend on a replaced view; no `CASCADE` is used. Apple views are created by the loads themselves ([reader views](#reader-views)), so the Apple app publishes nothing after a pass.

`PostgresSyncHistory({ url })` from `elt-postgresql` is the pipeline's [sync history](#sync-history) for this warehouse. Each pass inserts one `sync_attempts` row, with the connection name as `connector` and the source identity as `source`, and one `extraction_coverage` row per selected stream, with the source's declared `coverage(stream)` and the connection destination's schema as `target_schema`, before it reads; the outcomes close them. A run passes every stream a connection selected; a watch pass reads only the streams its source reported changed, so an attempt vouches only for its own `extraction_coverage` rows. An invalid connection, or a connection whose watcher stopped, records a failed attempt without outcomes. Use the same database for the history and the connection's destination. The Apple app's `main.ts` records every watch pass this way; Google's connector records one run.

Every attempt retains its own declarations. `sync_status` gives the latest attempt separately from the most recently completed all-copies-successful attempt. `stream_status` gives the same two facts for each stream, because a watch pass declares only the streams that changed. An unchanged pass advances success even with zero writes. A failed or partial pass keeps earlier success and its original scope available by attempt ID. Per-copy status and failure partitions let a reader distinguish successful streams within a partial attempt. Counts are accepted operations committed during that pass, including deduplication no-ops and deletions of absent keys, not changed-row counts or current totals. A first failure has no successful timestamp.

Coverage is **configured scope**, not observed minimum/maximum dates and not evidence of upstream completeness. For Calendar event and related streams, `selection.startAt` and `selection.endAt` are the configured UTC overlap interval `[startAt, endAt)`; zero-duration events must start in it. The declaration exists even when zero events match. Accounts and calendars have no date filter. ICS may describe a recurring series beyond the selected occurrences. Other Apple streams export the accessible local store without a configured date filter; this cannot promise complete cloud history or retrievable attachment bytes. Google declarations describe configured properties, report types, history/resume policies and inspection selection; they do not claim that every incremental pass rereads its entire configured history. A successful quota-limited URL inspection pass can leave due URLs pending until Pacific midnight.

Three clocks have different meanings: source record modification fields describe upstream changes; `loaded_at` describes the load that last wrote a row; `last_successful_sync_at` describes recorded pass completion. `search_console_freshness` reports observed dates and maximum row load time only. Neither table timestamps nor sync completion imply that a watcher is healthy. An attempt left `running` means only that completion was not recorded, including after process interruption or failure to persist outcomes. Metadata and destination commits are separate; unfinished metadata never claims success. Credentials/source setup before construction of a pipeline and Google's subsequent mart publication are outside the recorded extraction attempt. Missing metadata means unknown, not empty or current.

Apple content is read through one view per stream, `<source>_<stream>` in snake case (for example `notes_inline_attachments`, `messages_chat_handles`), with the stream's native field names as columns (quote camelCase names: `"noteId"`) plus `loaded_at`, and `attachmentRef` for streams with files. Each view and column carries the source's description: grain, keys, joins, null meanings, and where a native value comes from when its meaning is not documented. A view exists once its source's first load commits any stream, so an empty view can mean a stream still loading or failed; check `stream_status`. `marts.catalog` is the authority for available reader relations.

| Relation | Contents |
| --- | --- |
| `catalog` | Every view, table and column in `marts`, with its description. The agent's starting point. |
| `sync_status` | Latest attempt and last successful pass completion per connection, each with its attempt ID. |
| `stream_status` | Per connection and stream: the latest attempt that declared the stream with its copy status, and the last attempt in which that copy succeeded. A watch pass reads only changed streams, so judge a stream here, not in `sync_status`. |
| `sync_attempts` | Retained attempt history, start/completion times, status and errors. |
| `extraction_coverage` | Per attempt and stream: configured selection, scope explanation, target, copy outcome, committed counts and failed partitions. |
| `search_console_freshness` | Observed latest day, settled day and maximum row `loaded_at` per Search Console view, computed when read. Not sync status. |
| `search_console_totals_daily` | Authoritative totals per property, day and report type. |
| `search_console_queries_daily`, `search_console_pages_daily` | Web breakdowns. Pages add `page_path`. Rows a re-read no longer returns are hidden (only the latest load of each property and day shows). |
| `search_console_withheld_daily` | Web totals, the sum of query rows, and the difference Google withheld. |
| `search_console_countries` | The trailing country × device window with its `start_date` and `end_date`. |
| `search_console_properties`, `_sitemaps`, `_sitemap_contents`, `_url_inspection` (+ `_sitemaps`, `_referrers`) | The listings, in snake_case. Inspection adds `page_path`. |

Measures are additive only. The views carry `clicks`, `impressions`, `ranked_impressions` (impressions that had a rank) and `position_weight` (rank × impressions), and no per-row `ctr` or `position`. The only rates an agent can express are the correct ones: `sum(clicks)::float / nullif(sum(impressions), 0)` and `sum(position_weight) / nullif(sum(ranked_impressions), 0)`. Column descriptions state both. Dates are Pacific Time calendar days, and `settled` marks days Google may still restate.

Verified on 2026-09-24 against Postgres 18.3, first on a local Homebrew server. The tests load a fake Search Console through the real pipeline, install marts, and read as a fresh reader role. A separate run as the non-superuser `warehouse` and `agent_reader` roles, reading through `postgres-mcp` 0.3.0 in restricted mode, confirmed four things:
- The documented rate formulas return the expected values.
- Raw schemas answer `permission denied`.
- `COMMIT; CREATE TABLE …` fails validation.
- A three-billion-row count is cancelled after 30 seconds.

The compose stack was then started on Docker Desktop 4.92.0. The init script created both roles and the database, `elt-postgresql` tests passed against it, and the MCP container answered as `agent_reader` with `search_path` `marts`: it refused `pg_authid`, rejected a `COMMIT;` escape, and cancelled a long count at 30 seconds. A live load of `sc-domain:ezz.sh` into the compose warehouse then filled every view. Read as `agent_reader`, the observed-row freshness then showed data through 2026-09-24, settled through 2026-09-21, and `search_console_withheld_daily` showed Google withholding 1–2 clicks a day from the query rows.

### URL inspection and quota

URL inspection has no listing endpoint: each row costs one request naming one URL, against 2000 per day and 600 per minute for a property. The connector inspects every URL it can know about for a property:

- **Discovery.** Every URL listed by every sitemap the property has (`sitemaps.list`), fetched from the site: XML url sets, sitemap indexes (followed up to 3 levels), RSS 2.0 and Atom feeds, plain-text lists, gzipped or not. Plus every page in the full 16-month search analytics history, for each configured report type. `#fragments` are stripped (Google Search indexes documents, not anchors), duplicates merge, and only URLs under the property are kept. A page that is in no sitemap and never appeared in search cannot be discovered through any Google API.
- **Rolling refresh.** Each URL's last inspection time is kept in the stream's checkpoint. A run inspects never-inspected URLs first, then any whose last inspection is older than `inspectionRefreshHours` (default 24), stalest first; fresher URLs cost nothing. A property with more URLs than the daily quota is covered over successive days: each URL is refreshed about every ⌈URLs / 2000⌉ days.
- **Concurrency.** `inspectionConcurrency` (default 16) requests run at once, paced under 600 starts per minute, so a quota refusal can only mean the daily quota. Live, 126 URLs took 54 seconds where one-at-a-time took about 6.6 seconds per URL.
- **Quota.** When Google refuses for quota (a `429` that outlasts the retries), no new request starts, the ones in flight finish, and the inspections that succeeded are committed. The source makes no further inspection request for that property until the next midnight Pacific time, when per-day Google Cloud quotas reset.
- **Rejected URLs.** A `400` or `404` for one URL is loaded as a `urlInspection` row with `errorStatus` and `errorMessage` and null verdicts, and the run continues. A `401` or any other `403` would fail every URL alike, so it fails the copy.
- **Removal.** A URL that leaves the discovered set is deleted from all three tables; an array that shrank loses its extra positions.
- **Sharing.** One request serves all three streams: the source keeps its inspections in memory, and a stream uses one newer than what it last loaded before calling the API. The source reads `streamConcurrency` (default 4) streams at once, so the three inspection streams can run together; they take turns per property to plan and inspect, so a stream sees what the one before it inspected and no URL is inspected twice, while different properties never wait on each other.
- **Unreadable sitemaps** do not stop inspection. Each listed sitemap's outcome is loaded on the `sitemaps` stream (`urlsRead`, `readError`), and the URLs every other source shows are still inspected. Live, `https://ezz.sh/sitemap.xml` resets TLS connections, and Google itself last read it on 2025-07-20 with one error.

### Retry

Every Search Console call retries rate limits and transient server errors, then gives up loudly. Search Console allows 1200 queries per minute per site per user, and 40000 per minute and 30000000 per day per project.

| Response | Retried | When retries run out |
| --- | --- | --- |
| `429` | Yes | `SearchConsoleQuotaError`, with `status` and `attempts` |
| `403` with reason `rateLimitExceeded` or `userRateLimitExceeded` | Yes | `SearchConsoleQuotaError` |
| Any other `403` (insufficient scope, disabled API) | No | The original error, unchanged |
| `408`, `500`, `502`, `503`, `504` | Yes | The original error, unchanged |
| Anything else | No | The original error, unchanged |

The wait honors the server's `Retry-After`, in seconds or as an HTTP date. Without one, it doubles per attempt from `baseDelayMs` with full jitter, capped at `maxDelayMs`. A `Retry-After` longer than `maxDelayMs` fails at once instead of stalling the pipeline. The default policy is five attempts, one second base, one minute ceiling; pass `retry: { attempts, baseDelayMs, maxDelayMs }` to `SearchConsoleSource` to change it.

google-auth-library's transport, gaxios, has its own retry, but it is off by default, excludes `POST` (which `searchAnalytics.query` and URL inspection both use), and never reads `Retry-After`. The retry therefore lives in `SearchConsoleApi`, over the library-agnostic `GoogleRequester`.

### Watching

Search Console publishes no change notification. `watch()` polls every `pollIntervalMs` (default six hours) and first reads a cheap summary grouped by `date`, invalidating the analytics and listing streams only when `firstIncompleteDate` moved or a day's clicks or impressions changed. A restatement that leaves daily totals identical while reshuffling the per-query breakdown is not detected by this probe.

Inspections do not follow traffic. The source decides when they are due: it learns each URL's last inspection from the checkpoints its own extractions receive, and wakes only the inspection streams when the next URL falls due (or at the Pacific-midnight quota reset). Selecting only inspection streams never probes analytics. An app that calls `run()` and exits has no watcher; schedule it with the operating system (cron, launchd) and each run inspects whatever is due.

A property whose probe fails, for example after its permission was revoked, does not end the watch: the failure becomes part of that property's fingerprint, so when it starts or stops failing, the streams are invalidated and the extraction reports it or loads it, while the other properties keep being watched.

Aborting the watch signal cancels the probe's request and any `Retry-After` wait at once, so closing never sits out a rate-limit delay. The cancellation surfaces as the signal's `AbortError`, not the transport's wrapped error.

### Verified and unverified

Stream projection, positional key mapping, pagination, incremental checkpointing, restatement replacement, inspection batch sharing, watch gating, retry and abort behavior, the loopback consent flow, and grant reuse and re-consent are covered by tests using controlled API responses.

Live verification on **2026-09-22** ran the pipeline twice against a real property (`sc-domain:ezz.sh`) into SQLite, over `google-auth-library` 11.1.0 and Node.js 26.8.1:

- All seven streams loaded: 4 sites, 1 sitemap, 1 sitemap content row, 7736 analytics rows spanning 2025-07-21 to 2026-09-22, 9 inspected URLs, and 12 referrer rows.
- The API reported `firstIncompleteDate: 2026-09-21`, and the checkpoint stopped at `2026-09-20`.
- The second run extracted 135 rows rather than 7736, resuming at the checkpoint instead of re-reading the backfill window.
- Row count and distinct key count both stayed at 7736, so the re-read days replaced their rows instead of duplicating them. `loaded_at` on 2026-09-20 through 2026-09-22 advanced to the second run while 2026-09-19 kept the first run's value, which is the replacement the default `cursor_newer` guard would have skipped.

A second live run on the four-grain structure loaded 2280 daily rows across six report types, 3525 query rows, 1508 page rows and 261 country rows. All 380 Discover and all 380 Google News daily rows carried a null position, and the daily totals reproduced a standalone date-only request exactly (58 clicks, 1986 impressions for 2026-09-10 to 2026-09-20) where the former single wide stream saw 37 and 1020.

Live verification on **2026-09-24** repeated it over the loopback consent flow, since the runs above used the since-removed gcloud credential. The client was an existing Desktop-type OAuth client in the same Cloud project as the API:

- The first run found no grant, opened Google consent, stored the grant as owner-only files (`0700` directories, `0600` JSON, hashed names), then loaded all ten streams, resuming the analytics grains from the earlier checkpoint.
- The second run reused the stored grant with no browser and finished in 80 seconds. It re-read three days (18 daily rows across six report types) from the `2026-09-21` checkpoint.
- Every analytics table kept row count equal to distinct key count (2286 daily, 3571 query, 1514 page rows), so the re-read days replaced their rows.

Live verification on **2026-09-24** of the daily inspection quota on `sc-domain:limerence.sh`: 1868 inspections succeeded after 132 earlier that day (2000 in all), then Google answered `429` with reason `rateLimitExceeded`, status `RESOURCE_EXHAUSTED`, message "Quota exceeded for sc-domain:limerence.sh." and no `Retry-After`, not the `403 quotaExceeded` its error reference lists. The pool stopped with every earlier inspection kept, and a further call reported the quota exhausted without inspecting anything.

Live verification on **2026-09-24** of partitions: one source listing `sc-domain:ezz.sh`, `sc-domain:january.sh` and `sc-domain:limerence.sh` loaded every table in one run, with one checkpoint per stream holding a `{ partitions: [...] }` entry per property.

Live verification on **2026-09-25** of target ownership against `sc-domain:ezz.sh`: after the old `_mac_elt_writers` table was dropped, one run recreated it as `(target, writer)` with one row per table, each owned by its copy id (for example `sitemaps ← {"copy":"sitemaps"}`). A second copy from another source into `sitemaps` failed with `TargetOwnedError` naming both writers, extracted nothing, and left its row count unchanged.

Live verification on **2026-09-25** of failure isolation and clear, against `sc-domain:ezz.sh`:

- A run listing `sc-domain:ezz.sh` and `sc-domain:example.com` (no permission) ran every stream. `ezz.sh` loaded and checkpointed (for example 24 daily and 78 query rows), each partitioned stream reported `example.com` with Google's "User does not have sufficient permission for site 'sc-domain:example.com'", the run failed, and no `example.com` row or checkpoint entry was written. The next run with `ezz.sh` alone completed.
- `watch()` over the same two properties stayed open: its first batch loaded `ezz.sh` (18 daily rows) and reported `example.com` with the same permission message, where the property's failing probe used to end the watch before any load.
- Clearing the `sitemaps` copy emptied its table, owner row and checkpoint while `marts.search_console_sitemaps`, a view on it, kept working; the next run reloaded it from scratch. Dropping the table instead is refused by Postgres because of that view, which is why clear empties SQL tables.

Not exercised live: `watch()` over a real polling interval, Markdown destinations, a property large enough to page past 25000 rows, and the quota ceiling on URL inspection.

### Row ceiling

Two limits apply, and only one loses data. A request returns at most 25000 rows; the connector pages past that with `startRow`, so nothing is lost. Separately, Google keeps at most 50000 rows per day per report type for a property and states the API "does not guarantee to return all data rows"; beyond that, rows are dropped with no signal. This is documented by Google, not observed: the live property's busiest day had 39 query rows.
