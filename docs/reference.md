# API and behavior reference

[Back to the README](../README.md)

Detailed sync, storage, connector, and failure contracts for `elt`.

## Working example

The examples below live inside `apps/apple/src`: import pipeline types from `elt` and Apple connectors from the app's `./index.ts`. Later snippets reuse `notes`, `sqlite`, and `checkpoints` from this example.

```ts
import {
  Copy,
  Pipeline,
  SQLiteCheckpointStore,
  SQLiteDestination,
} from 'elt';
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
      cursorField: 'modifiedAt',
      primaryKey: ['id'],
    }),
  ],
});

const results = await pipeline.run(); // [{ copy, count }, ...] in declaration order
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

## Identity, cursors, and schemas

Three separate concepts control identity:

- `Stream.primaryKey` describes source identity. It does not create SQL uniqueness or select deduplication automatically.
- `Copy` options `primaryKey: ['id']` or `['tenantId', 'id']` select the identity used by a deduplicating load.
- `.primaryKey()` on a SQLite column is a physical constraint. Conflicting append operations fail and roll back that copy; they never silently become updates.

Both deduplication modes require explicit `primaryKey` and `cursorField`. Fields must be top-level scalar properties declared with one non-null JSON Schema type. Keys support text, finite numbers, safe integers, and booleans; cursors support text or numbers. Missing/null values fail. Composite keys are supported; nested field paths and nullable key/cursor schemas are not. Explicit SQL projections must include all selected keys and the cursor with matching types.

The greatest cursor wins. Older arrivals are ignored after validation. Equal cursors retain the first stored record, including across runs. This makes replay deterministic; a source that changes content without changing its cursor cannot distinguish those versions. Text uses UTF-8 byte order, matching SQLite `BINARY`; timestamps should use one canonical UTC ISO format. All observations are validated, even losing versions.

SQLite inference maps flat JSON Schema fields: `string` → `TEXT`, `integer` → `INTEGER`, `number` → `REAL`, `boolean` → `INTEGER` with a 0/1 constraint. Nullable scalars are supported for ordinary fields. Missing optional fields become SQL `NULL`. Explicit columns support `text`, `integer`, `real`, `blob`, and `boolean`; they allow null unless marked `.notNull()` or `.primaryKey()`. Missing/undefined explicit fields fail. An explicit projection can omit unsupported nested fields.

SQLite creates strict tables. Existing SQL constraints remain authoritative; there are no schema migrations. Deduplication additionally verifies stored key/cursor column types and rejects null keys/cursors. It uses native [UPSERT with a cursor comparison](https://www.sqlite.org/lang_upsert.html) and a reserved `_mac_elt_dedup_*` unique index. Changing to ordinary append/overwrite removes that mode-owned index while retaining explicit constraints. An existing append-history table with repeated keys must be replaced with `overwrite_dedup` before incremental deduplication can start.

Every SQLite copy adds `loaded_at`, a reserved UTC load timestamp. The count returned for a committed copy is the number of accepted input observations, including deduplication no-ops; it is not the final row count.

## Incremental extraction and checkpoints

Incremental copies require an explicit stable `id` and a `SQLiteCheckpointStore`. Use a separate persistent SQLite state file, including when the destination is Markdown. IDs must be unique within a pipeline. Copying the same stream to two targets requires two IDs, so progress in one does not advance the other.

`Source.read(configuration, previousState)` receives `null` initially. It emits `{ stream, data }` records and `{ type: 'STATE', stream, state }` checkpoints. State is losslessly JSON serializable and source-owned; destinations do not interpret it. Writers snapshot proposed state and return `WriteResult { count, checkpoints }` only after committing/publishing the complete copy. Acknowledgements retain their order; orchestration persists the last one. No acknowledgement means no advancement, even if the source mutates its input state.

The store binds each ID to the source identity, target declaration, schema and selected configuration. A changed binding fails before extraction. Use a new ID or explicitly reset progress:

```ts
checkpoints.reset('notes-to-sqlite'); // Next read starts from null; destination data is unchanged.
await pipeline.run();
```

Resetting append progress may duplicate data. Resetting deduplicated progress reconciles replayed records. Reset state when deleting/replacing destination storage; bindings cannot detect that content was removed. Do not share a state file between independent machines or put it inside a managed Markdown folder. Its parent directory must exist.

Data and checkpoint commits are separate. If data commits but state persistence fails, retry may replay records: delivery is **at least once**. Append keeps replayed observations; deduplication reconciles them. No batching or resumable full refresh is implemented. State-file transactions serialize copies using that file; concurrent attempts fail with SQLite's lock error, and native locks release on process exit. Use separate state files for independent parallel pipelines. The state file must differ from the SQLite destination file.

### Apple Notes behavior

Notes and attachments support `cursorField: 'modifiedAt'`. Accounts and folders support full refresh only. Attachment reads contain metadata unless the target declares file-derived fields. Protected note content remains null.

JXA still scans and validates the full collection. Incremental filtering reduces emitted records, not scan cost. Records at the saved timestamp are replayed inclusively. The next watermark is the greatest observed timestamp capped at scan start, so changes during a scan remain eligible for replay. An empty scan preserves the previous watermark. Timestamps must be canonical UTC ISO strings with four-digit years.

This reader has no deletion events or consistent database snapshot. Incremental loading does not remove deleted notes, and it can miss late/backdated changes whose timestamps precede the watermark. Use full refresh overwrite when you need to reconcile the current snapshot. These are source limitations, not deduplication behavior.

## Watching for changes

Use the same configured pipeline for continuous synchronization:

```ts
const controller = new AbortController();

for await (const results of pipeline.watch({ signal: controller.signal })) {
  // These copies have already extracted, loaded, and saved their checkpoints.
  console.table(results.map(({ copy, count }) => ({
    stream: copy.from.name,
    processed: count,
  })));
}

// Call controller.abort() from your app's stop/shutdown handler.
```

Watching preflights the whole pipeline, subscribes before the initial synchronization, and then reruns copies whose streams receive notifications. It uses the existing copy modes: the incremental Notes recipe above remains incremental; Calendar and Reminders retain full-refresh extraction. Notifications do not provide records or turn a full-refresh source into an incremental one. `run()` remains a single execution, and the runnable Apple app still uses it.

The source owns change detection:

- **Calendar and Reminders:** a persistent OSA process subscribes to native `EKEventStoreChangedNotification` notifications. These invalidate all selected streams because EventKit does not identify individual changes. The notification covers the whole event store, so a Calendar edit also re-extracts a Reminders watch, and a Reminders edit also re-extracts a Calendar watch. The existing EventKit permission requirements apply. Full-refresh overwrite reconciles deletions on the next successful pass.
- **Notes:** Node's native `fs.watch` watches `~/Library/Group Containers/group.com.apple.notes` recursively and triggers the existing JXA reader. This is a filesystem invalidation hint over private Notes storage, not a public note-change subscription. It can also fire for unrelated storage activity, and signals concern persisted changes rather than every keystroke. It requires access to that protected directory, potentially Full Disk Access for the host process, as well as the existing Notes Automation permission for extraction. Denied access fails with an actionable error; there is no polling fallback. The reader still scans the collection, and incremental mode still does not remove deleted notes.

Runs are serial. Notifications received during extraction or while the caller handles a result are coalesced into a pending set of streams, so they cause a subsequent pass without an unbounded queue of sync jobs. Every yielded result has completed loading and checkpoint persistence; `count` still counts accepted observations, including deduplication no-ops. A load failure raises `PipelineError`; a watcher failure is propagated. No automatic retries or periodic reconciliation are added.

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
  console.log(error.completed);      // Earlier successful { copy, count } results.
  console.log(error.failedCopy);     // The copy that stopped execution.
  console.log(error.committedCount); // Accepted records if it committed before an error.
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
      cursorField: 'modifiedAt',
    }),
  ],
});
await exportPipeline.run();
```

`file()` stores the stream in one document; `folder()` stores one record per document. Both retain every record field, including nested JSON. The optional title field supplies headings; otherwise headings use record positions. Values are escaped Markdown text; HTML stays text. Non-JSON values fail instead of being silently discarded or coerced.

Managed v2 documents include base64-encoded JSON record comments alongside their visible sections. Append and deduplication read these canonical records, without parsing rendered Markdown or using a SQL sidecar. These comments are not encryption. Generated files are owned by the export; manual edits are replaced. Earlier layouts have no compatibility reader or migration.

Ordinary overwrite/append requires no key. Folder filenames represent record occurrences, so repeated source IDs remain separate. Deduplicated folders hash the selected key values instead; title changes do not change identity. The old `folder({ key })` option is removed: selected deduplication keys belong to the copy. Reconciliation currently holds the target in memory and republishes its complete contents.

Target names use lowercase letters, digits, hyphens and underscores, beginning with a letter; files additionally end in `.md`. Nested paths and traversal are rejected. Only regular managed files, or managed folders containing only generated record files, can be replaced. Unmanaged files, subdirectories and symlinks are protected; siblings stay untouched.

A file publishes with a rename after staging and closing. A folder moves the old directory to a backup before publishing the staged directory. If publication fails, it restores the backup; if restoration also fails, it preserves the sole backup and reports its location. Folder switching has a brief path gap between renames. Publication is not a filesystem-wide or power-loss transaction.

An exclusive `.markdown-<target>.lock` directory prevents cooperating concurrent writes to either layout. Normal completion/failure removes staging and locks unless a recovery backup must remain. Abrupt termination can leave staging, a backup and a stale lock; inspect and restore the backup before removing the lock and retrying.

## Apple Reminders

```ts
import { Copy, Pipeline, SQLiteDestination } from 'elt';
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

All eight streams support full refresh and work with inferred SQLite tables or Markdown targets. Discovery and validation perform no native reads or permission requests. The first extraction requests permission if undecided, waiting up to 30 seconds. Denied, restricted, pending, and revoked access throw `RemindersUnavailableError`, retaining the process error as its cause. Asynchronous fetches time out after 60 seconds and cancel the request. A nil fetch result is an error; only a successful empty array can clear a target. Failed reads preserve the previous contents of the affected target. The OS permission prompt itself and execution on macOS 14 and 15 have not been verified; only macOS 26 was exercised.

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

EventKit IDs can change after a full server sync; external identifiers are not universally unique or stable across providers/devices. Child IDs identify positions within the current snapshot. Full-refresh overwrite reconciles deletions; incremental extraction remains unsupported because modification timestamps alone do not provide a deletion feed. Streams are queried independently, without a cross-stream snapshot or pipeline-wide transaction. OSA buffers each complete response up to 64 MiB and has a 120-second process timeout; large collections can exceed those limits.

See the [EventKit research and implementation notes](eventkit-reminders.md) for API evidence, design choices, verification, and migration details.

## Apple Calendar

```ts
import { mkdir } from 'node:fs/promises';
import { Copy, Pipeline, SQLiteDestination } from 'elt';
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

### Streams

All nine streams support full refresh and work with inferred SQLite tables or Markdown targets. Related collections are separate scalar rows, preserving their data without adding JSON columns to SQLite.

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

Native enums and bitmasks remain integers. Missing optional values remain `null`; zero recurrence count means no count-based limit. Schema details are available on each stream's `jsonSchema`.

### Dates and occurrence identity

The required bounds are canonical UTC ISO timestamps with `startAt < endAt`. They select the half-open interval `[startAt, endAt)`: overlapping events are included; a zero-duration event is included when its start lies in the interval. The range is part of the immutable source identity. Construction, discovery, and preflight perform no native reads.

EventKit expands recurrence and applies deleted/rescheduled occurrence exceptions. The source queries in windows of at most 365 days to avoid EventKit's silent four-year query truncation, and removes repeated occurrence rows across window boundaries. An unbounded export is not supported because a repeating series may have no end.

`startAt`, `endAt`, and other timestamps retain native instants as UTC strings. For all-day events, `startDate` and `endDate` separately preserve the local Gregorian dates in EventKit's default time zone. `endDate` is **inclusive**: it is the event's last day. EventKit stores an all-day event as ending one second before the next local midnight. A live probe on **2026-09-24** (macOS 26.6.2, Asia/Amman) saved a one-day and a two-day all-day event from 25 September. They exported `endAt` `2026-09-25T20:59:59.000Z` with `endDate` `2026-09-25`, and `2026-09-26T20:59:59.000Z` with `endDate` `2026-09-26`. Both events had a null `timeZone`. The probe deleted both events and confirmed their removal with a fresh read. To get a half-open range, add one day to `endDate`. A null `timeZone` remains null; it is not replaced with UTC. Timed events have null date-only fields.

The event `id` (also exposed as `eventId`) combines the calendar identifier, local calendar-item identifier, and the original occurrence date for repeating/detached events. It uses the native original date rather than the rescheduled start; all-day occurrence keys use a calendar date. Native event and external identifiers remain separate fields. EventKit identifiers can change after moves or full server syncs, so these are local extraction identities, not permanent cross-device IDs. Child IDs add the collection kind/component and position; they identify snapshot rows, not independently stable native objects.

Scripting metadata uses native identifier lookups, never title-based matching. Its `id` is the JSON tuple `[calendarId, calendarItemId]`; expanded occurrences of the same native item share one metadata row. Each scripting query reads at most 100 native items, continuing by identifier even when an excluded-date page is empty. Scripting dates are checked against the stored EventKit item, whose start may precede the occurrence window. For detached events, Calendar returns the parent series' `scriptingUid` and raw recurrence, but the detached item's own sequence and excluded-date list. The returned scripting UID is therefore kept separate from `calendarItemId`.

Markdown uses the same source; for example, `new Copy(calendar.events, markdown.folder('events', { title: 'name' }))`. Use lowercase target names such as `recurrence-rules` for camel-cased streams.

### Completeness and limits

Full-refresh overwrite reconciles deletions and events moved outside the selected window on the next successful run. Ordinary append retains observations. Each stream is read separately, so concurrent Calendar changes can affect relationships; the pipeline has no cross-stream snapshot or transaction. OSA still buffers at most 64 MiB per query and times out after 120 seconds; very dense windows can exceed those limits. Duplicate tracking retains occurrence/child IDs for the duration of one copy.

The source preserves the EventKit and scripting fields above. These remaining capabilities require more than another source field:

- **Incremental deletion/move reconciliation:** EventKit provides change notifications but no durable change cursor or deletion feed here. The current `SourceMessage` protocol also has no delete/tombstone message or scoped reconciliation operation. Calendar therefore rejects incremental extraction.
- **Attachments, travel time, and conference metadata:** EventKit and Calendar's scripting interface do not provide attachment file export or dedicated travel/conference fields. The existing file-transfer pipeline can load staged files, but this source cannot supply those bytes. Deprecated open-file alarm URLs are also unavailable on modern macOS.
- **Consistent multi-stream snapshots and resumable large exports:** these need additional extraction/checkpoint and pipeline support. Full refresh currently restarts a failed copy, preserving its previous destination contents until the complete replacement succeeds.

See Apple's [EventKit retrieval documentation](https://developer.apple.com/documentation/eventkit/retrieving-events-and-reminders), [occurrence identity](https://developer.apple.com/documentation/eventkit/ekevent/occurrencedate), and [calendar-item identity caveats](https://developer.apple.com/documentation/eventkit/ekcalendaritem/calendaritemidentifier).

### Calendar export probe

A read-only probe on macOS 26.6.2 (2026-09-21) checked Calendar's **File > Export** output:

- **`.ics`:** the sample preserved raw recurrence rules, excluded dates, recurrence IDs, five attachment references, and Google/Microsoft conference properties. It contained no embedded attachment bytes; three references were HTTPS URLs and two were relative query references requiring provider context.
- **`.icbu`:** the archive contained `Calendar.sqlitedb` and `Info.plist`. Its five attachment records had no local file paths or embedded payloads. The database included travel-time columns, but every sampled value was null, so travel-time preservation remains unverified.

These exports establish a route to additional metadata, not a complete attachment backup. This source does not import either format. Reading `.ics` metadata and retrieving referenced files would require an additional extractor and, where required, provider authentication. The archive's private database schema is not a stable public API. Personal probe exports were temporary and are not repository fixtures.

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
  siteUrl: 'sc-domain:example.com',
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

| Stream | Extraction | Notes |
| --- | --- | --- |
| `sites` | Full refresh | Properties the grant can read. `siteUnverifiedUser` entries are dropped: Google lists them, but their history cannot be read. |
| `sitemaps` | Full refresh | int64 counts arrive as decimal strings; omitted counts and flags mean zero and false. |
| `sitemapContents` | Full refresh | The per-content-type rows nested in each sitemap, keyed by `sitemapPath` and `type`. |
| `searchAnalyticsDaily` | Incremental | Site-wide totals per day **per report type**, with `searchType` as a column. Key `[date, searchType]`. |
| `searchAnalyticsQueries` | Incremental | Per day and query, web results only. Key `[date, query]`. |
| `searchAnalyticsPages` | Incremental | Per day and page, web results only. Key `[date, page]`. |
| `searchAnalyticsCountries` | Full refresh | Country and device for a trailing `breakdownMonths` window (default 3). No date dimension, so it cannot be resumed. Key `[country, device]`. |
| `urlInspection` | Full refresh | One request per URL. |
| `urlInspectionSitemaps` / `urlInspectionReferrers` | Full refresh | The arrays nested in the index status result, keyed by `inspectionUrl` and `position`. |

#### Why the grains are separate

Google withholds rare queries for privacy, and the loss compounds with every dimension added to a request. Measured against one live property over 2026-09-10 to 2026-09-20:

| Request | Rows | Clicks | Impressions |
| --- | --- | --- | --- |
| `['date']` | 11 | 58 | 1986 |
| `['date','query','page','country','device']` | 749 | 37 | 1020 |

A single wide request loses 36% of clicks and 49% of impressions, and no aggregation of it can recover the property's real totals. Each grain is therefore its own stream with its own window: `searchAnalyticsDaily` stays authoritative for totals, and the breakdowns are only comparable within themselves. Google additionally caps a property at 50,000 rows per day per search type and states the API "does not guarantee to return all data rows", so a high-cardinality request receives silent truncation rather than an error.

Consequences for anything querying these tables: average `position` must be weighted by impressions over non-null rows, `ctr` must be recomputed as `SUM(clicks) / SUM(impressions)` rather than averaged, and query or page rows will not sum to the daily totals.

#### Projection

- `ApiDataRow.keys` is **positional** against requested `dimensions`; the API never names the columns. A row whose key count disagrees with the request is skipped rather than failing the copy.
- Proto3 omits zero-valued fields, so an absent `clicks`, `impressions` or `ctr` loads as `0`.
- `position` is **nullable**, and absent for a different reason: Discover and Google News report no rank at all, on every row including zero-traffic ones. Loading a missing rank as `0` would claim the best possible position. Verified live: all 380 Discover and all 380 Google News daily rows carry no position.
- Sitemap `warnings`/`errors`/`submitted` are `string/int64` → parsed to integer, non-safe integers rejected.
- `date` is a **PST calendar date**, not an instant (`format: 'date'`).
- The 16-month history window is calendar arithmetic clamped to the end of a shorter month: sixteen months before 31 March is 30 November. Counting 480 days instead drifts by roughly a week and silently drops history.

The report types change which rows exist, so they are part of the source identity (`search-console:<siteUrl>:<searchTypes>`). The window is not: it moves with the clock, and state resumes it.

### Incremental search analytics

Google revises recent metrics for roughly two to three days. The response metadata reports `firstIncompleteDate`, the first day still being collected, so the connector does not guess a lookback:

- State is `{ date: '<last settled day>' }`.
- A run resumes **at** the saved date rather than after it, so the last settled day is re-read. That re-read is the lookback.
- Requests use `dataState: 'ALL'`, and the checkpoint advances to `firstIncompleteDate` minus one day, or to the end date when the API reports none.
- Rows are paginated by `startRow` at 25000 per page until a short page.

Because `date` is both the cursor and part of the key, each resumable grain requires `dedupPolicy: 'replace'`. With the default guard the restated day would be discarded. `searchAnalyticsDaily` requests one window per report type and keeps the earliest settled boundary across them, because report types settle independently.

### URL inspection and quota

URL inspection has no listing endpoint: each row costs one request naming one URL, against roughly 2000 per day and 600 per minute for a property. The connector derives its URL list from a `searchAnalytics` query grouped by `page` over `inspectionWindowDays` (default 28), sorted by impressions, capped at `inspectionLimit` (default 200). Inspections run sequentially, and one batch is shared by the three `urlInspection` streams so loading all of them spends the per-URL quota once. A rate limit that outlasts the retry policy becomes `SearchConsoleQuotaError` and fails the copy rather than truncating the set.

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

Search Console publishes no change notification. `watch()` polls every `pollIntervalMs` (default six hours) and first reads a cheap summary grouped by `date`, invalidating the selected streams only when `firstIncompleteDate` moved or a day's clicks or impressions changed. A restatement that leaves daily totals identical while reshuffling the per-query breakdown is not detected by this probe.

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

Not exercised live: `watch()` over a real polling interval, Markdown destinations, a property large enough to page past 25000 rows, and the quota ceiling on URL inspection.

### Row ceiling

Two limits apply, and only one loses data. A request returns at most 25000 rows; the connector pages past that with `startRow`, so nothing is lost. Separately, Google keeps at most 50000 rows per day per report type for a property and states the API "does not guarantee to return all data rows"; beyond that, rows are dropped with no signal. This is documented by Google, not observed: the live property's busiest day had 39 query rows.
