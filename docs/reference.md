# API and behavior reference

[Back to the README](../README.md)

Detailed sync, storage, connector, and failure contracts for `elt`.

## Working example

The examples below live inside `apps/apple/src`: import pipeline types from `elt`, the SQLite destination from `elt-sqlite`, and Apple connectors from the app's `./index.ts`. Later snippets reuse `notes`, `sqlite`, and `checkpoints` from this example.

```ts
import { Copy, Pipeline, SQLiteCheckpointStore } from 'elt';
import { SQLiteDestination } from 'elt-sqlite';
import { AppleNotesSource } from './index.ts';

const notes = new AppleNotesSource();
const sqlite = new SQLiteDestination({ path: './notes.sqlite' });
const checkpoints = new SQLiteCheckpointStore({ path: './checkpoints.sqlite' });

const pipeline = new Pipeline({
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
      primaryKey: ['id'],
    }),
  ],
});

const results = await pipeline.run(); // [{ copy, count, deleted }, ...] in declaration order
```

Accounts uses an explicit destination projection; notes uses inferred columns. Apple Notes exposes `accounts`, `folders`, `notes`, and `attachments` directly. `discover()` returns the same immutable descriptions for generic code that enumerates streams. Neither discovery nor constructing a declaration reads Notes or opens storage.

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

A deduplicating copy that leaves `dedupPolicy` unset uses `cursor_newer`. Both destinations apply the policy: SQLite as the upsert guard above, Markdown when it merges each record with the previously published one or with an earlier record from the same run.

Selecting `cursor_newer` with a cursor that is a member of `primaryKey` is rejected. A conflict on that key implies an equal cursor, so the guard could never fire and a restated record would load as a no-op that reports a count without changing the row. The rejection names the field and points at `replace`.

```ts
new Copy(source.searchAnalytics, destination.table('raw_search_analytics'), {
  id: 'search-analytics',
  syncMode: 'incremental',
  destinationSyncMode: 'append_dedup',
  dedupPolicy: 'replace',
  cursorField: 'date',
  primaryKey: ['date', 'query', 'page', 'country', 'device'],
});
```

Capabilities are immutable metadata:

```ts
notes.accounts.supportedSyncModes; // ['full_refresh']
notes.notes.supportedSyncModes;    // ['full_refresh', 'incremental']
sqlite.supportedDestinationSyncModes;
// ['overwrite', 'append', 'append_dedup', 'overwrite_dedup']
```

### Deletions

A stream that declares `emitsDeletes` can send `DELETE` messages during incremental reads, each carrying exactly the stream's `primaryKey` fields. Such copies must use `append_dedup` with the stream's own `primaryKey`, so the destination can find the row:

| Destination | Effect of `DELETE` |
| --- | --- |
| SQLite `append_dedup` | Deletes the row with that key inside the copy's transaction. |
| Markdown `append_dedup` file or folder | Drops the record before the target is republished. |

Records and deletions apply in the order the source emits them, and deleting an absent key is a no-op, so replaying a run is safe. A deletion is rejected when the stream does not declare `emitsDeletes`, when its key is malformed, or when the load does not deduplicate. Results report accepted deletions as `deleted`, separately from `count`.

### Shared targets

Every destination records which writers load each target, stored with the target and committed with the load. A writer is the copy's `id`, or the source identity and stream name for a copy without one; its claim also records its mode, key, and the [partitions](#partitioned-streams) it loads. Before a copy extracts or changes anything, the target checks its claim against the other writers':

| Writers of one target | Allowed |
| --- | --- |
| All `append_dedup` on the same `primaryKey`, in the same order, over disjoint partitions | Yes. Each upserts and deletes only keys inside its own partitions, so none removes or shadows another's rows. |
| `append_dedup` on the same key, but sharing a partition or not partitioned | No. A snapshot copy deletes keys it once saw, which can be keys the other writer loads, and an unpartitioned writer may hold any key. |
| Any `overwrite` or `overwrite_dedup` | No. It empties the whole target, including the other writers' rows. |
| Any `append` | No. An append log cannot tell its rows apart from another writer's. |
| `append_dedup` on different keys | No. One target holds one deduplication key. |

A refused copy fails before extraction and leaves the target unchanged; a pipeline also refuses such a pair among its own copies before running any. The error names both writers, their modes and keys. A writer may change its own mode or key. To reassign a target, drop it: a dropped SQLite table or a deleted Markdown file or folder releases its claims, and the next load starts from scratch. SQLite keeps claims in the reserved `_mac_elt_writers` table; Markdown keeps them in the file's header comment or the folder's marker file.

Several properties or accounts can therefore share tables either through one partitioned source, which is one writer, or through one pipeline per property whose source lists only that property.

## Identity, cursors, and schemas

Three separate concepts control identity:

- `Stream.primaryKey` describes source identity. It does not create SQL uniqueness or select deduplication automatically.
- `Copy` options `primaryKey: ['id']` or `['tenantId', 'id']` select the identity used by a deduplicating load.
- `.primaryKey()` on a SQLite column is a physical constraint. Conflicting append operations fail and roll back that copy; they never silently become updates.

Both deduplication modes require an explicit `primaryKey`. `cursor_newer` also requires `cursorField`; `replace` works without one. A stream with `sourceDefinedCursor` has no cursor field: its copies omit `cursorField`, and its deduplicating loads default to and require `replace`. Fields must be top-level scalar properties declared with one non-null JSON Schema type. Keys support text, finite numbers, safe integers, and booleans; cursors support text or numbers. Missing/null values fail. Composite keys are supported; nested field paths and nullable key/cursor schemas are not. Explicit SQL projections must include all selected keys and the cursor with matching types.

The greatest cursor wins. Older arrivals are ignored after validation. Equal cursors retain the first stored record, including across runs. This makes replay deterministic; a source that changes content without changing its cursor cannot distinguish those versions. Text uses UTF-8 byte order, matching SQLite `BINARY`; timestamps should use one canonical UTC ISO format. All observations are validated, even losing versions.

SQLite inference maps flat JSON Schema fields: `string` → `TEXT`, `integer` → `INTEGER`, `number` → `REAL`, `boolean` → `INTEGER` with a 0/1 constraint. Nullable scalars are supported for ordinary fields. Missing optional fields become SQL `NULL`. Explicit columns support `text`, `integer`, `real`, `blob`, and `boolean`; they allow null unless marked `.notNull()` or `.primaryKey()`. Missing/undefined explicit fields fail. An explicit projection can omit unsupported nested fields.

SQLite creates strict tables. Existing SQL constraints remain authoritative; there are no schema migrations. Table names starting with `_mac_elt_` are reserved. Deduplication additionally verifies stored key/cursor column types and rejects null keys/cursors. It uses native [UPSERT with a cursor comparison](https://www.sqlite.org/lang_upsert.html) and a reserved `_mac_elt_dedup_*` unique index. Changing to ordinary append/overwrite removes that mode-owned index while retaining explicit constraints. An existing append-history table with repeated keys must be replaced with `overwrite_dedup` before incremental deduplication can start.

Every SQLite copy adds `loaded_at`, a reserved UTC load timestamp. The `count` returned for a committed copy is the number of accepted input observations, including deduplication no-ops, and `deleted` is the number of accepted deletions, including keys that were already absent; neither is the final row count.

## Incremental extraction and checkpoints

Incremental copies require an explicit stable `id` and a `SQLiteCheckpointStore`. Use a separate persistent SQLite state file, including when the destination is Markdown. IDs must be unique within a pipeline. Copying the same stream to two targets requires two IDs, so progress in one does not advance the other.

`Source.read(configuration, previousState)` receives `null` initially. It emits `{ stream, data }` records, `{ type: 'DELETE', stream, key }` deletions and `{ type: 'STATE', stream, state }` checkpoints. State is losslessly JSON serializable and source-owned; destinations do not interpret it. Writers snapshot proposed state and return `WriteResult { count, deleted, checkpoints }` only after committing/publishing the complete copy. Acknowledgements retain their order; orchestration persists the last one. No acknowledgement means no advancement, even if the source mutates its input state.

The store binds each ID to the source identity, target declaration, schema and selected configuration. A changed binding fails before extraction. Use a new ID or explicitly reset progress:

```ts
checkpoints.reset('notes-to-sqlite'); // Next read starts from null; destination data is unchanged.
await pipeline.run();
```

Resetting append progress may duplicate data. Resetting deduplicated progress reconciles replayed records. Reset state when deleting/replacing destination storage; bindings cannot detect that content was removed. Do not share a state file between independent machines or put it inside a managed Markdown folder. Its parent directory must exist.

Data and checkpoint commits are separate. If data commits but state persistence fails, retry may replay records: delivery is **at least once**. Append keeps replayed observations; deduplication reconciles them. No batching or resumable full refresh is implemented. State-file transactions serialize copies using that file; concurrent attempts fail with SQLite's lock error, and native locks release on process exit. Use separate state files for independent parallel pipelines. The state file must differ from the SQLite destination file.

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

`Source.read` calls `extract` once per partition, in the listed order, and keeps each partition's state apart. The checkpoint is `{ partitions: [{ partition, state }] }`, owned by the library:

- **New partition:** it receives `null` and starts from the source's normal beginning, for example a full history backfill, while the others resume.
- **Removed partition:** it leaves the checkpoint; its rows stay loaded. Reading it again later starts it from `null`.
- **Identity:** the partition list is not part of the source identity or the checkpoint binding, so adding or removing a partition never invalidates the others' checkpoints.
- **Rows:** every record and every `DELETE` key must carry its partition's values; a row naming another partition, or none, fails the copy. Deduplicating copies must include the `partitionKey` fields in their `primaryKey`.
- **Failures:** a copy is one transaction, so a failing partition rolls back every partition's rows and checkpoint.
- **Full refresh:** partitions are read the same way without state, and an overwrite replaces the whole target with every listed partition.

Partitions are declared without I/O: `partitionKey` fields must be distinct non-null scalar members of the primary key, and the list must be non-empty with no repeats.

### Apple Notes behavior

All four streams are [snapshot streams](#snapshot-streams): incremental copies select no `cursorField` and use `append_dedup` keyed by `id`. Each run scans and validates the full collection through JXA, writes only new and changed records, and deletes records that disappeared. A change is detected from the record's content, so edits that keep an older `modifiedAt` are still loaded. Attachment reads contain metadata unless the target declares file-derived fields; files are exported only for new or changed attachments, and a changed file whose metadata did not change is not detected. Protected note content remains null.

Notes returns notes in Recently Deleted, so they remain in the export until permanently deleted. JXA reads each stream separately, without a consistent database snapshot across streams.

## Watching for changes

Use the same configured pipeline for continuous synchronization:

```ts
const controller = new AbortController();

for await (const results of pipeline.watch({ signal: controller.signal })) {
  // These copies have already extracted, loaded, and saved their checkpoints.
  console.table(results.map(({ copy, count, deleted }) => ({
    stream: copy.from.name,
    processed: count,
    deleted,
  })));
}

// Call controller.abort() from your app's stop/shutdown handler.
```

Watching preflights the whole pipeline, subscribes before the initial synchronization, and then reruns copies whose streams receive notifications. It uses the existing copy modes: incremental Notes and Calendar copies stay incremental, and full-refresh copies stay full refresh. Notifications do not provide records or turn a full-refresh copy into an incremental one. `run()` remains a single execution, and the runnable Apple app still uses it.

The source owns change detection:

- **Calendar and Reminders:** a persistent OSA process subscribes to native `EKEventStoreChangedNotification` notifications. These invalidate all selected streams because EventKit does not identify individual changes. The notification covers the whole event store, so a Calendar edit also re-extracts a Reminders watch, and a Reminders edit also re-extracts a Calendar watch. The existing EventKit permission requirements apply. Full-refresh overwrite reconciles deletions on the next successful pass.
- **Notes:** Node's native `fs.watch` watches `~/Library/Group Containers/group.com.apple.notes` recursively and triggers the existing JXA reader. This is a filesystem invalidation hint over private Notes storage, not a public note-change subscription. It can also fire for unrelated storage activity, and signals concern persisted changes rather than every keystroke. It requires access to that protected directory, potentially Full Disk Access for the host process, as well as the existing Notes Automation permission for extraction. Denied access fails with an actionable error; there is no polling fallback. The reader still scans the collection, and incremental mode still does not remove deleted notes.

Runs are serial. Notifications received during extraction or while the caller handles a result are coalesced into a pending set of streams, so they cause a subsequent pass without an unbounded queue of sync jobs. Every yielded result has completed loading and checkpoint persistence; `count` and `deleted` still count accepted observations, including deduplication no-ops and absent keys. A load failure raises `PipelineError`; a watcher failure is propagated. No automatic retries or periodic reconciliation are added.

Aborting stops native observation, lets an in-flight pass finish and yield its result, and prevents another pass. Breaking the loop also closes the watcher. A new watch session subscribes and performs an initial pass again, using the saved checkpoints. Notifications themselves are not durable, and the source's existing snapshot/cursor limitations still apply.

Custom sources declare a `catalog` and implement `observe({ streams, signal }): AsyncIterable<readonly Stream[]>`. The base `Source` owns `discover()`, `validate()`, and `watch()`: before extracting or observing, it rejects any stream that is not the same object as its catalog's stream of that name. A stream's schema shapes the destination, so a lookalike stream with a matching name is refused. Add source-specific selection rules, such as a required cursor field, by overriding `validateExtraction()`. In `observe()`, establish observation before yielding all selected streams once; then emit the affected selected streams until cancellation. The pipeline keeps consuming these invalidations while it loads records. Close native resources when aborted or when the iterator is closed; errors must propagate. `Stream` remains immutable metadata, and loading continues through `Source.read`, `Copy`, and the destination writers.

Automated verification covers actual filesystem events in temporary storage, native EventKit observer delivery using process-local notifications without personal data, and destination/checkpoint visibility before results are yielded. The native filesystem test requires an environment that permits filesystem notifications; this host's sandbox reports `EMFILE` even for a single temporary-directory watcher, while the same probe succeeds outside it.

Live verification on **2026-09-22**, using **macOS 26.6.2 and Node.js 26.8.1**, exercised the existing sources, `Pipeline.watch()`, `Copy`, and temporary SQLite destinations without mocking notifications or extraction. Calendar and Reminders each completed four observed passes: initial sync, creation, update, and deletion. Their mutations were real EventKit writes from separate OSA processes. Notes mutations were made through the Notes GUI; its successful run completed 26 passes because filesystem notifications also fire for intermediate and unrelated storage changes. SQLite assertions ran after the watcher yielded completed loads.

| Source stream | Live assertions |
| --- | --- |
| Calendar `events` | A uniquely labeled event appeared, its changed title and start time reached SQLite, and deleting it removed the exported row. The fixed occurrence window was `2026-09-22T00:00:00.000Z` to `2026-09-23T00:00:00.000Z`. |
| Reminders `reminders` | A uniquely labeled reminder appeared, its changed title and completed status reached SQLite, and deleting it removed the exported row. |
| Notes `notes` | A uniquely labeled note appeared, its edited body reached SQLite, and permanently deleting it from Recently Deleted removed the exported row. |

Watchers were closed after verification. The Calendar test event, temporary Reminders list, both Notes test records, and temporary databases were removed. EventKit cleanup was checked through fresh native reads; Notes cleanup was confirmed in its UI and the successful run's SQLite output. Existing user records were not modified. This live pass covered the primary streams and SQLite; Calendar/Reminders GUI edits, other streams, and Markdown were not exercised live.

**Notes access and deletion semantics:** the initial storage probe returned `EPERM` even outside the sandbox. Opening Notes and granting the host process Full Disk Access resolved it. Normal deletion moves a note to Recently Deleted, which remains visible through `app.notes()` and therefore remains in the export. Full-refresh overwrite removes the exported row after permanent deletion. The first live probe timed out while investigating this distinction; a second run verified the complete create/update/permanent-delete sequence. This does not change incremental extraction's existing lack of deletion reconciliation.

## Attachment files and document parsing

```ts
import { MacOSDocumentParser } from './index.ts';

const attachmentCopy = new Copy(
  notes.attachments,
  sqlite.table('attachments', c => [
    c.text('id'),
    c.text('containerId'),
    c.text('content').from(notes.attachments.file).parse(new MacOSDocumentParser()),
    c.blob('bytes').from(notes.attachments.file),
  ]),
  {
    syncMode: 'full_refresh',
    destinationSyncMode: 'overwrite',
  },
);

await new Pipeline({
  source: notes,
  destination: sqlite,
  steps: [attachmentCopy],
}).run();
```

This stores the selected source metadata, parsed `content` as TEXT, and the original file in the `bytes` BLOB column. All are committed together. The original attachment ID and containing note ID remain available for joins. Append preserves each observation and its bytes; deduplication keeps the text and bytes belonging to the winning cursor.

The columns declare what to extract and where to store it. `Copy` collects those declarations; `Source.read()` performs the file reads and parsing. SQLite receives ordinary record values and binds them to native TEXT/BLOB columns. Omitting the BLOB column avoids retaining the original file; omitting all file-derived columns avoids exporting files altogether.

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

A bare table still infers the discovered metadata schema. To include all metadata alongside file-derived columns, spread `SQLiteColumns.fromSchema(notes.attachments.jsonSchema)` into the columns array. A plain `c.blob('bytes')` reads a record's existing `bytes` field. `.from(file)` selects the original source file; `.parse(parser)` requests its text representation. Unparsed file reads require a BLOB column; parsed files require a TEXT column. The existing `.notNull()` and `.primaryKey()` constraints apply to both. Incompatible types, another stream's file reference, and fields colliding with source metadata or `loaded_at` fail before extraction.

`notes.attachments.file` is an immutable source reference, not a path. Other Notes streams reject file access. All declarations remain immutable and perform no I/O; the discovered source schema is never rewritten to describe destination fields. A file can supply multiple named representations in one copy. Each record is exported once; requests using the same parser instance share one parse, and original-byte requests share one read. Separate copies retain separate extraction and checkpoint progress.

Markdown targets use the same destination-independent `FileRead` declaration, alongside their existing metadata rendering:

```ts
import { FileRead } from 'elt';

new Copy(notes.attachments, markdown.folder('attachments', {
  fields: [new FileRead('content', notes.attachments.file, new MacOSDocumentParser())],
}));
```

Markdown accepts parsed text fields and rejects unparsed binary requests before I/O. Its `file()` target supports the same options as `folder()`.

This follows Airbyte's source-side parser and staged-file concepts: its [file parser Strategy](https://github.com/airbytehq/airbyte-python-cdk/blob/f77450f74def59598cda8e1e9a4e975031710c18/airbyte_cdk/sources/file_based/file_types/file_type_parser.py) interprets files, while [file transfer](https://docs.airbyte.com/platform/using-airbyte/sync-files-and-records) moves original content with metadata. Our parser emits plain text, not Airbyte's Markdown conversion, and we do not claim its complete format/OCR support or wire compatibility.

`MacOSDocumentParser` uses native PDFKit for PDFs with a text layer and native `textutil` for TXT, Markdown, RTF, HTML, DOC, DOCX, ODT, and WordML. It selects the format from the filename extension, preserves text/Markdown content, and strips rich formatting when converting other formats to plain text. HTML conversion does not load external resources. Images, PowerPoint, OCR, locked PDFs, and files without a supported extension are not supported. PDFs with no extractable text and corrupt or unsupported documents fail the copy; there is no implicit skip policy. PDF parsing uses the existing OSA command's 64 MiB output buffer and 120-second timeout. Text conversion uses Node's native `execFile` defaults (1 MiB output limit and no timeout).

Notes exports through its scripting `save` command into a disposable staging directory. We never read its private database or treat an attachment's URL as a download URL. URL attachments, attachments inside password-protected notes, and objects whose native `contents` property is missing retain metadata with null content/bytes. The `contents` property is used only to check file availability; `save` still performs the export. Actual export errors fail the copy. An unnamed attachment with file contents can be requested as an original file, but the native parser cannot choose its format without an extension. Sources do not invent missing filenames or claim an unsuccessful export succeeded.

`Source.read()` is the shared template method. Source implementations provide protected `extract(configuration, state)`, yielding metadata, optional staged file paths, and state. The source resolves `configuration.fileReads` into named text or byte values before yielding records to the destination. Staging paths stay inside extraction; writers reject any leaked path. The source cleans staging on success, cancellation, and failure. Binary fields hold each complete file in memory; large files require a different storage strategy.

Extend `DocumentParser` with `parse(path): Promise<string>` for another parsing implementation. Give it a stable identity that includes its version and relevant configuration; keep the implementation/configuration immutable and parse without modifying the staged file. A parser does not depend on Notes or SQLite. Parser identity participates in the copy's checkpoint binding; changing it requires a new copy ID or explicit checkpoint reset. Source keys and cursors remain metadata fields, and acknowledgement still waits for complete destination commit.

The loaded `content` can be queried with normal SQL or indexed with SQLite FTS5 in the consuming application. Parsing does not create a search index. No query API or general transformation step is part of this library.

## Execution and failures

`Pipeline.run()` preflights every copy before executing any of them. Unknown streams, unsupported combinations, invalid schema declarations, missing keys/cursors/IDs/state store, and duplicate copy IDs fail without extraction or storage creation. Preflight uses metadata; storage permissions, existing constraints and record values are checked during execution. Standalone `Copy.run(source, destination, checkpoints?)` validates too.

Copies then execute in declaration order. Each SQLite copy opens its own handle and transaction; each Markdown copy stages its complete output. Errors before commit/publication preserve the previous output for that copy. Empty overwrite clears it; empty append preserves existing records. Earlier copies remain committed if a later copy fails. There is no pipeline-wide rollback.

```ts
import { PipelineError } from 'elt';

try {
  await pipeline.run();
} catch (error) {
  if (!(error instanceof PipelineError)) throw error; // Preflight errors are direct.
  console.log(error.completed);  // Earlier successful { copy, count, deleted } results.
  console.log(error.failedCopy); // The copy that stopped execution.
  console.log(error.committed);  // { count, deleted } if it committed before an error.
  console.error(error.cause);        // Original error, or CommittedWriteError with its cause.
}
```

A cleanup error after publication, or a checkpoint-save error after data commit, is reported as `CommittedWriteError`. Such a failure does not imply data rollback. A count of zero also covers a committed empty input. Later copies are not executed.

Declarations are frozen and reusable. `Destination.createWriter(configuration, target)` selects a storage-specific strategy without I/O. Writers own connections, files, counters, and publication. `Copy`/`Pipeline` contain no SQL/filesystem loading branches. `Source.identity` and `Destination.identity(target)` provide stable checkpoint bindings; custom implementations must distinguish different source instances/targets/configuration domains.

SQLite holds its transaction during extraction. Long reads can block other writers. `:memory:` is allowed only for full refresh; each copy's database disappears when its handle closes, so it cannot safely retain incremental progress.

## Markdown destination

```ts
import { MarkdownDestination } from 'elt';

const markdown = new MarkdownDestination({ path: './exports' });
const exportPipeline = new Pipeline({
  source: notes,
  destination: markdown,
  checkpoints,
  steps: [
    new Copy(notes.accounts, markdown.file('accounts.md', { title: 'name' })),
    new Copy(notes.notes, markdown.folder('notes', { title: 'name' }), {
      id: 'notes-to-markdown',
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
      primaryKey: ['id'],
    }),
  ],
});
await exportPipeline.run();
```

`file()` stores the stream in one document; `folder()` stores one record per document. Both retain every record field, including nested JSON. The optional title field supplies headings; otherwise headings use record positions. Values are escaped Markdown text; HTML stays text. Non-JSON values fail instead of being silently discarded or coerced.

Managed v3 documents include a writer-claims comment and base64-encoded JSON record comments alongside their visible sections. Append and deduplication read these canonical records, without parsing rendered Markdown or using a SQL sidecar. These comments are not encryption. Generated files are owned by the export; manual edits are replaced. Earlier layouts have no compatibility reader or migration.

Ordinary overwrite/append requires no key. Folder filenames represent record occurrences, so repeated source IDs remain separate. Deduplicated folders hash the selected key values instead; title changes do not change identity. The old `folder({ key })` option is removed: selected deduplication keys belong to the copy. Reconciliation currently holds the target in memory and republishes its complete contents.

Target names use lowercase letters, digits, hyphens and underscores, beginning with a letter; files additionally end in `.md`. Nested paths and traversal are rejected. Only regular managed files, or managed folders containing only generated record files, can be replaced. Unmanaged files, subdirectories and symlinks are protected; siblings stay untouched.

A file publishes with a rename after staging and closing. A folder moves the old directory to a backup before publishing the staged directory. If publication fails, it restores the backup; if restoration also fails, it preserves the sole backup and reports its location. Folder switching has a brief path gap between renames. Publication is not a filesystem-wide or power-loss transaction.

An exclusive `.markdown-<target>.lock` directory prevents cooperating concurrent writes to either layout. Normal completion/failure removes staging and locks unless a recovery backup must remain. Abrupt termination can leave staging, a backup and a stale lock; inspect and restore the backup before removing the lock and retrying.

## Postgres destination

`PostgresDestination({ url, schema })` from `elt-postgresql` loads every table of a pipeline into one schema, created on first load. The URL carries credentials, so it stays private: `identity()` records host, port, database, schema and target, never the user or password. Declarations are checked without connecting.

Inferred columns follow the stream schema, and unlike SQLite the string formats get their own types, so readers can do date arithmetic:

| JSON Schema | Postgres |
| --- | --- |
| `string` | `TEXT` |
| `string` + `format: 'date'` | `DATE` |
| `string` + `format: 'date-time'` | `TIMESTAMPTZ` |
| `integer` | `BIGINT` |
| `number` | `DOUBLE PRECISION` |
| `boolean` | `BOOLEAN` |

Explicit columns use `columns.text/integer/real/boolean/date/timestamp(field)` with `.notNull()` and `.primaryKey()`. File reads are not supported. Identifiers are case-sensitive and limited to 63 bytes, because Postgres would silently truncate a longer one; `_mac_elt_` names and a `loaded_at` column are reserved, and `pg_` schemas are refused.

Each copy is one transaction that holds a per-schema advisory lock, so writers to one schema run one at a time. Readers never wait on the lock:

- Overwrite empties the table with `DELETE`, not `TRUNCATE`, because the transaction stays open while the source is read and `TRUNCATE` would block readers for all of it. Until commit, readers see the previous load.
- Records are inserted in batches of 1000, sent as one JSON parameter and cast per column. Every row of a copy shares one `loaded_at` (`TIMESTAMPTZ`), the transaction's start time.
- Deduplication upserts on a unique index named after the table and key (`_mac_elt_dedup_<hash>`). The index is created once and rebuilt only when the key changes. Within a batch, one row per key is kept, as applying the batch row by row would: `replace` keeps the last and `cursor_newer` keeps the first with the greatest cursor. Text cursors compare by bytes (`COLLATE "C"`).
- Deletions apply in source order: pending records are written first.
- Writer claims live in `<schema>._mac_elt_writers` and follow the [shared-target rules](#shared-targets).

Existing tables are not migrated: a deduplicating load checks that stored key and cursor columns keep their types and fails otherwise. Checkpoints still use `SQLiteCheckpointStore`, so the data and the checkpoint commit separately, as with SQLite.

## Apple Reminders

```ts
import { Copy, Pipeline } from 'elt';
import { SQLiteDestination } from 'elt-sqlite';
import { AppleRemindersSource } from './index.ts';

const reminders = new AppleRemindersSource();
const sqlite = new SQLiteDestination({ path: './reminders-eventkit.sqlite' });

await new Pipeline({
  source: reminders,
  destination: sqlite,
  steps: (await reminders.discover()).streams.map(stream =>
    new Copy(stream, sqlite.table(stream.name)),
  ),
}).run();
```

Reminders uses **EventKit exclusively**, accessed through the existing JXA/OSA runner. It does not use Reminders.app's scripting API, and the app need not be open. macOS 14 or later and full Reminders permission are required for the process running the export. Enable access in **System Settings > Privacy & Security > Reminders**. Calendar permission and Automation permission do not substitute for it. A packaged host must supply `NSRemindersFullAccessUsageDescription` and any required sandbox entitlements.

All eight streams support full refresh and [snapshot incremental](#snapshot-streams) and work with inferred SQLite tables or Markdown targets. Discovery and validation perform no native reads or permission requests. The first extraction requests permission if undecided, waiting up to 30 seconds. Denied, restricted, pending, and revoked access throw `RemindersUnavailableError`, retaining the process error as its cause. Asynchronous fetches time out after 60 seconds and cancel the request. A nil fetch result is an error; only a successful empty array can clear a target. Failed reads preserve the previous contents of the affected target. The OS permission prompt itself and execution on macOS 14 and 15 have not been verified; only macOS 26 was exercised.

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

Date components preserve undefined values as `null`, including missing clock components for date-only reminders. A null time zone means a floating date/time; it is never silently replaced with UTC. Start, due, and item time zones remain separate. No UTC due instant is invented from a date-only or floating reminder. `dayOfYear` is null when unavailable before macOS 15; `repeatedDay` is null when unavailable before macOS 26. Native timestamp properties remain UTC ISO strings. Missing start/due properties produce no component row. On macOS 26.6.2, EventKit refused non-Gregorian date-component calendars (`Calendar must be nil or Gregorian`). It also normalized a due time set with only an hour and no calendar: the stored components carried the Gregorian calendar and `minute: 0`. Exports report the components EventKit stores, not the values an app originally assigned.

Native enum values remain integers. Alarm proximity is `0` (none), `1` (arrival), or `2` (departure); a radius of `0` asks the system to choose a radius. Recurrence frequency is `0` (daily), `1` (weekly), `2` (monthly), or `3` (yearly). A zero recurrence count means no count-based limit. Only the next incomplete reminder in a recurring series is exposed by Apple; the source does not invent future occurrences or deliver notifications.

EventKit IDs can change after a full server sync; external identifiers are not universally unique or stable across providers/devices. Child IDs identify positions within the current snapshot. Full-refresh overwrite and snapshot incremental both reconcile deletions; incremental still fetches every reminder each run, because EventKit offers no change feed. Streams are queried independently, without a cross-stream snapshot or pipeline-wide transaction. OSA buffers each complete response up to 64 MiB and has a 120-second process timeout; large collections can exceed those limits.

See the [EventKit research and implementation notes](eventkit-reminders.md) for API evidence, design choices, verification, and migration details.

## Apple Calendar

```ts
import { mkdir } from 'node:fs/promises';
import { Copy, Pipeline } from 'elt';
import { SQLiteDestination } from 'elt-sqlite';
import { AppleCalendarSource } from './index.ts';

await mkdir('./outputs', { recursive: true });
const calendar = new AppleCalendarSource({
  startAt: '2026-09-01T00:00:00.000Z',
  endAt: '2026-10-01T00:00:00.000Z',
});
const sqlite = new SQLiteDestination({ path: './outputs/apple-calendar.sqlite' });

await new Pipeline({
  source: calendar,
  destination: sqlite,
  steps: (await calendar.discover()).streams.map(stream =>
    new Copy(stream, sqlite.table(stream.name)),
  ),
}).run();
```

Calendar uses the public EventKit framework through the existing OSA bridge. It needs macOS 14 or later and full Calendar access for the process running the export. The first extraction requests access if it is undecided or write-only, waiting up to 30 seconds. If permission is denied, restricted, or still pending, `CalendarUnavailableError` preserves the native cause and explains how to enable access. A sandbox can block access even when macOS permission is granted. Permission failures never become empty successful exports.

The `calendars`, `eventMetadata`, and `excludedDates` streams also read Calendar's scripting interface and require macOS Automation access to Calendar. This can launch Calendar.app. The other streams use EventKit alone. Scripting failures and mismatched native lookups fail the copy with the original cause.

The `icsComponents`, `icsProperties`, and `icsParameters` streams read each item's iCalendar export through **private** EventKit API (`EKEventStore` `ICSDataForCalendarItems:preventLineFolding:`, falling back to `:options:`). They need no Automation access. The source checks for the method first: when a macOS version lacks it, the copy fails with `CalendarIcsUnavailableError` rather than exporting nothing, and an export without any event component fails too. A macOS update can remove or change this API; select only the public streams if that matters more than ICS coverage.

### Streams

All thirteen streams support full refresh and snapshot incremental (`append_dedup` keyed by `id`, no `cursorField`; see [snapshot streams](#snapshot-streams)) and work with inferred SQLite tables or Markdown targets. Related collections are separate scalar rows, preserving their data without adding JSON columns to SQLite.

| Stream | Contents and relationships |
| --- | --- |
| `accounts` | EventKit sources: identifier, name, native source type, delegate flag. |
| `calendars` | Identifier, `accountId`, name, scripting description, native type, write/subscription/immutability flags, sRGB components, supported availability and entity masks. |
| `events` | Expanded occurrences: native identifiers, `calendarId`, title/body/location/URL, start/end, all-day dates, time zone, creation/modification dates, original occurrence date, detached flag, status/availability, birthday contact identifier, geographic location. |
| `eventMetadata` | One row per selected native calendar item: `calendarId`, `calendarItemId`, returned `scriptingUid`, raw recurrence string (or null), and sequence number. Join to occurrences using both `calendarId` and `calendarItemId`. |
| `excludedDates` | `eventMetadataId`, position, excluded instant (`excludedAt`), and local `excludedDate` for all-day items. These are recurrence metadata and may lie outside the selected occurrence window. |
| `attendees` | `eventId`, position, participant name/URL, native status/role/type, current-user flag. `kind` distinguishes attendees from the organizer. |
| `alarms` | `eventId`, position, native alarm type, relative offset in seconds, absolute date, email/sound, proximity and geographic location. |
| `recurrenceRules` | `eventId`, position, calendar identifier, frequency, interval, first weekday, end date and occurrence count. |
| `recurrenceRuleValues` | `ruleId`, `eventId`, component and position, integer value, optional weekday ordinal. Preserves weekdays, month/year days, year weeks, months, and set positions. |
| `icsComponents` | One row per iCalendar component of a native item (`VCALENDAR`, `VEVENT`, `VALARM`, `VTIMEZONE`, …): `id` `[calendarId, calendarItemId, path]`, `eventMetadataId`, `parentId`, `position`, `name`, `uid`, the raw `recurrenceId` with its `recurrenceIdTimeZone` (TZID), and `eventId` when it is exact (the master of a non-recurring event). |
| `icsProperties` | Every property except `DTSTAMP`, with its raw value: `componentId`, `position`, `name`, `value`. Includes `ATTACH`, `RRULE`, `EXDATE`, `RECURRENCE-ID`, `URL`, and vendor properties such as `X-GOOGLE-CONFERENCE` and `X-MICROSOFT-*`. |
| `icsAttachments` | One row per `ATTACH`: `uri` (raw), `filename` (`X-APPLE-FILENAME` or `FILENAME`), `formatType` (`FMTTYPE`), `inline`. Supports file transfer: inline base64 content is decoded locally; remote references are downloaded by the `attachments` fetcher given to `AppleCalendarSource`, and a file the fetcher reports as unreachable loads as `null`. |
| `icsParameters` | One row per parameter value: `propertyId`, `componentId`, `position`, `valuePosition`, `name`, `value` (for example `ATTACH;FMTTYPE`, `ATTACH;FILENAME`, `DTSTART;TZID`). |

Native enums and bitmasks remain integers. Missing optional values remain `null`; zero recurrence count means no count-based limit. Schema details are available on each stream's `jsonSchema`.

### Dates and occurrence identity

The required bounds are canonical UTC ISO timestamps with `startAt < endAt`. They select the half-open interval `[startAt, endAt)`: overlapping events are included; a zero-duration event is included when its start lies in the interval. The range is not part of the source identity (`apple-calendar:eventkit`), so an incremental copy can move its window between runs: occurrences that leave it are deleted. Construction, discovery, and preflight perform no native reads.

EventKit expands recurrence and applies deleted/rescheduled occurrence exceptions. The source queries in windows of at most 365 days to avoid EventKit's silent four-year query truncation, and removes repeated occurrence rows across window boundaries. An unbounded export is not supported because a repeating series may have no end.

`startAt`, `endAt`, and other timestamps retain native instants as UTC strings. For all-day events, `startDate` and `endDate` separately preserve the local Gregorian dates in EventKit's default time zone. `endDate` is **inclusive**: it is the event's last day. EventKit stores an all-day event as ending one second before the next local midnight. A live probe on **2026-09-24** (macOS 26.6.2, Asia/Amman) saved a one-day and a two-day all-day event from 25 September. They exported `endAt` `2026-09-25T20:59:59.000Z` with `endDate` `2026-09-25`, and `2026-09-26T20:59:59.000Z` with `endDate` `2026-09-26`. Both events had a null `timeZone`. The probe deleted both events and confirmed their removal with a fresh read. To get a half-open range, add one day to `endDate`. A null `timeZone` remains null; it is not replaced with UTC. Timed events have null date-only fields.

The event `id` (also exposed as `eventId`) combines the calendar identifier, local calendar-item identifier, and the original occurrence date for repeating/detached events. It uses the native original date rather than the rescheduled start; all-day occurrence keys use a calendar date. Native event and external identifiers remain separate fields. EventKit identifiers can change after moves or full server syncs, so these are local extraction identities, not permanent cross-device IDs. Child IDs add the collection kind/component and position; they identify snapshot rows, not independently stable native objects.

Scripting metadata uses native identifier lookups, never title-based matching. Its `id` is the JSON tuple `[calendarId, calendarItemId]`; expanded occurrences of the same native item share one metadata row. Each scripting query reads at most 100 native items, continuing by identifier even when an excluded-date page is empty. Scripting dates are checked against the stored EventKit item, whose start may precede the occurrence window. For detached events, Calendar returns the parent series' `scriptingUid` and raw recurrence, but the detached item's own sequence and excluded-date list. The returned scripting UID is therefore kept separate from `calendarItemId`.

Markdown uses the same source; for example, `new Copy(calendar.events, markdown.folder('events', { title: 'name' }))`. Use lowercase target names such as `recurrence-rules` for camel-cased streams.

### Completeness and limits

Full-refresh overwrite and snapshot incremental both reconcile deletions and events moved outside the selected window on the next successful run; incremental writes only the rows that changed. Ordinary append retains observations. Child rows are keyed by position, so reordering attendees or alarms rewrites the affected rows. Each stream is read separately, so concurrent Calendar changes can affect relationships; the pipeline has no cross-stream snapshot or transaction. OSA still buffers at most 64 MiB per query and times out after 120 seconds; very dense windows can exceed those limits. Duplicate tracking retains occurrence/child IDs for the duration of one copy.

The source preserves the EventKit and scripting fields above. These remaining capabilities require more than another source field:

- **Change feed:** EventKit provides change notifications but no durable change cursor, so every incremental run still reads the whole window.
- **Attachment bytes and travel time:** the ICS streams carry attachment references (`ATTACH` values and their parameters) and conference properties, not file contents. Exported attachment URLs can require provider context or authorization, so they are not treated as portable files. Travel time is not exported. Deprecated open-file alarm URLs are unavailable on modern macOS.
- **Consistent multi-stream snapshots and resumable large exports:** these need additional extraction/checkpoint and pipeline support. Full refresh currently restarts a failed copy, preserving its previous destination contents until the complete replacement succeeds.

See Apple's [EventKit retrieval documentation](https://developer.apple.com/documentation/eventkit/retrieving-events-and-reminders), [occurrence identity](https://developer.apple.com/documentation/eventkit/ekevent/occurrencedate), and [calendar-item identity caveats](https://developer.apple.com/documentation/eventkit/ekcalendaritem/calendaritemidentifier).

### Calendar export probe

A read-only probe on macOS 26.6.2 (2026-09-21) checked Calendar's **File > Export** output:

- **`.ics`:** the sample preserved raw recurrence rules, excluded dates, recurrence IDs, five attachment references, and Google/Microsoft conference properties. It contained no embedded attachment bytes; three references were HTTPS URLs and two were relative query references requiring provider context.
- **`.icbu`:** the archive contained `Calendar.sqlitedb` and `Info.plist`. Its five attachment records had no local file paths or embedded payloads. The database included travel-time columns, but every sampled value was null, so travel-time preservation remains unverified.

These GUI exports are not used. The ICS streams read the same iCalendar data per item through EventKit instead. The archive's private database schema is not a stable public API. Personal probe exports were temporary and are not repository fixtures.

### Attachment files

`icsAttachments` reads attachment bytes only when the target asks for them, and remote references need a fetcher. For Google calendars, `googleCalendarAttachments` from the Google app downloads Drive files (native Docs, Sheets and Slides as PDF) and Gmail message attachments. It needs a grant with `drive.readonly` and `gmail.readonly` from an OAuth client whose project enables the Drive and Gmail APIs:

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

Construct it with an authenticated requester from `googleSession`:

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

- **First run.** With no stored grant covering the scopes, it listens on `http://127.0.0.1:<random port>/callback`, prints the consent link (and opens it on macOS), and waits up to five minutes. Only a redirect carrying the flow's `state` is accepted; any other request gets `400` and the listener keeps waiting.
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

The example app lists every property in one source, so each table has one writer. Separate pipelines per property also work: give each copy an id that names its property and load incrementally, so a snapshot copy deletes only keys its own snapshot held and the dated grains upsert by keys that include `siteUrl`. A full-refresh `overwrite` empties the whole table, so the [shared-target rules](#shared-targets) refuse it next to another writer.

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

The example app loads into the compose Postgres warehouse and installs a reading layer for agents. The layout:

```text
warehouse database
├── google_search_console   raw tables loaded by elt-postgresql; readers have no access
├── marts                   views and one table, every object and column described
└── public                  revoked from PUBLIC
roles: warehouse (loads, owns the database) · agent_reader (reads marts only)
```

- **Privileges are the barrier.** `agent_reader` has `CONNECT`, `USAGE` on `marts` and `SELECT` on its relations, and nothing else. It has no `TEMP`, no `CREATE`, and no access to raw schemas. Views run with their owner's rights. The role's settings (`default_transaction_read_only`, `statement_timeout 30s`, `search_path = marts`) are only defaults, since a session may change them.
- **Agents connect through Postgres MCP Pro**, `crystaldba/postgres-mcp:0.3.0` in `--access-mode=restricted`, served over SSE on `127.0.0.1:8000` (see `infra/docker-compose.yml` and `.mcp.json`). The server holds the reader's password. It parses each statement, rejects anything but reads (including `COMMIT; …` escapes), and cancels statements after 30 seconds. It does not cap result rows.
- **Only built-in functions.** Restricted mode allows only a fixed list of built-in functions and cannot be configured. The marts therefore expose no functions: every calculation lives inside a view, where the check does not look, or is computed at load time. Helpers such as `marts._url_path` are internal.

`installWarehouse(sql, { reader })` sets up the shared parts: grants, the `marts` schema, `catalog` and `freshness`. `installSearchConsoleMarts(sql, { raw, reader })` then replaces the Search Console views in one transaction and refreshes `freshness`. Both run as the loader after every load. A view that another connector built on top of these makes the reinstall fail rather than disappear, because it drops views without `CASCADE`.

| Relation | Contents |
| --- | --- |
| `catalog` | Every view, table and column in `marts`, with its description. The agent's starting point. |
| `freshness` | Per view: latest day, latest settled day, last load. Refreshed after every load. |
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

The compose stack was then started on Docker Desktop 4.92.0. The init script created both roles and the database, `elt-postgresql` tests passed against it, and the MCP container answered as `agent_reader` with `search_path` `marts`: it refused `pg_authid`, rejected a `COMMIT;` escape, and cancelled a long count at 30 seconds. A live load of `sc-domain:ezz.sh` into the compose warehouse then filled every view. Read as `agent_reader`, `freshness` showed data through 2026-09-24, settled through 2026-09-21, and `search_console_withheld_daily` showed Google withholding 1–2 clicks a day from the query rows.

### URL inspection and quota

URL inspection has no listing endpoint: each row costs one request naming one URL, against 2000 per day and 600 per minute for a property. The connector inspects every URL it can know about for a property:

- **Discovery.** Every URL listed by every sitemap the property has (`sitemaps.list`), fetched from the site: XML url sets, sitemap indexes (followed up to 3 levels), RSS 2.0 and Atom feeds, plain-text lists, gzipped or not. Plus every page in the full 16-month search analytics history, for each configured report type. `#fragments` are stripped (Google Search indexes documents, not anchors), duplicates merge, and only URLs under the property are kept. A page that is in no sitemap and never appeared in search cannot be discovered through any Google API.
- **Rolling refresh.** Each URL's last inspection time is kept in the stream's checkpoint. A run inspects never-inspected URLs first, then any whose last inspection is older than `inspectionRefreshHours` (default 24), stalest first; fresher URLs cost nothing. A property with more URLs than the daily quota is covered over successive days: each URL is refreshed about every ⌈URLs / 2000⌉ days.
- **Concurrency.** `inspectionConcurrency` (default 16) requests run at once, paced under 600 starts per minute, so a quota refusal can only mean the daily quota. Live, 126 URLs took 54 seconds where one-at-a-time took about 6.6 seconds per URL.
- **Quota.** When Google refuses for quota (a `429` that outlasts the retries), no new request starts, the ones in flight finish, and the inspections that succeeded are committed. The source makes no further inspection request for that property until the next midnight Pacific time, when per-day Google Cloud quotas reset.
- **Rejected URLs.** A `400` or `404` for one URL is loaded as a `urlInspection` row with `errorStatus` and `errorMessage` and null verdicts, and the run continues. A `401` or any other `403` would fail every URL alike, so it fails the copy.
- **Removal.** A URL that leaves the discovered set is deleted from all three tables; an array that shrank loses its extra positions.
- **Sharing.** One request serves all three streams: the source keeps its inspections in memory, and a stream uses one newer than what it last loaded before calling the API.
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

Live verification on **2026-09-24** of shared tables, target ownership and partitions, against `sc-domain:ezz.sh`, `sc-domain:january.sh` and `sc-domain:limerence.sh`:

- Two per-property pipelines loaded `ezz.sh` then `january.sh` into the same file: every table held both properties (for example 2292 and 2934 daily rows), and the second load left the first property's rows untouched.
- A full-refresh `overwrite` copy pointed at the shared `raw_sitemaps` was refused before extraction, naming the `append_dedup` writer that owns it; both properties' rows remained.
- One source listing all three properties loaded every table in one run, with one checkpoint per stream holding a `{ partitions: [...] }` entry per property and one writer claim per table.
- A second pipeline covering `ezz.sh` and `limerence.sh` was refused on a table where `ezz.sh` already had a writer, while separate `ezz.sh` and `january.sh` pipelines shared it.

Not exercised live: `watch()` over a real polling interval, Markdown destinations, a property large enough to page past 25000 rows, and the quota ceiling on URL inspection.

### Row ceiling

Two limits apply, and only one loses data. A request returns at most 25000 rows; the connector pages past that with `startRow`, so nothing is lost. Separately, Google keeps at most 50000 rows per day per report type for a property and states the API "does not guarantee to return all data rows"; beyond that, rows are dropped with no signal. This is documented by Google, not observed: the live property's busiest day had 39 query rows.
