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

- **Calendar and Reminders:** a persistent OSA process subscribes to native `EKEventStoreChangedNotification` notifications. These invalidate all selected streams because EventKit does not identify individual changes. The existing EventKit permission requirements apply. Full-refresh overwrite reconciles deletions on the next successful pass.
- **Notes:** Node's native `fs.watch` watches `~/Library/Group Containers/group.com.apple.notes` recursively and triggers the existing JXA reader. This is a filesystem invalidation hint over private Notes storage, not a public note-change subscription. It can also fire for unrelated storage activity, and signals concern persisted changes rather than every keystroke. It requires access to that protected directory, potentially Full Disk Access for the host process, as well as the existing Notes Automation permission for extraction. Denied access fails with an actionable error; there is no polling fallback. The reader still scans the collection, and incremental mode still does not remove deleted notes.

Runs are serial. Notifications received during extraction or while the caller handles a result are coalesced into a pending set of streams, so they cause a subsequent pass without an unbounded queue of sync jobs. Every yielded result has completed loading and checkpoint persistence; `count` still counts accepted observations, including deduplication no-ops. A load failure raises `PipelineError`; a watcher failure is propagated. No automatic retries or periodic reconciliation are added.

Aborting stops native observation, lets an in-flight pass finish and yield its result, and prevents another pass. Breaking the loop also closes the watcher. A new watch session subscribes and performs an initial pass again, using the saved checkpoints. Notifications themselves are not durable, and the source's existing snapshot/cursor limitations still apply.

Custom sources implement `watch({ streams, signal }): AsyncIterable<readonly Stream[]>`. Establish observation before yielding all selected streams once; then emit the affected selected streams until cancellation. The pipeline keeps consuming these invalidations while it loads records. Close native resources when aborted or when the iterator is closed; errors must propagate. `Stream` remains immutable metadata, and loading continues through `Source.read`, `Copy`, and the destination writers.

Verification covers actual filesystem events in temporary storage, native EventKit observer delivery using process-local notifications without personal data, and destination/checkpoint visibility before results are yielded. The native filesystem test requires an environment that permits filesystem notifications; this host's sandbox reports `EMFILE` even for a single temporary-directory watcher, while the same probe succeeds outside it. Live Notes directory observation returned `EPERM` even outside the sandbox; actual personal Notes edits and cross-process Calendar/Reminders edits remain unverified.

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

All eight streams support full refresh and work with inferred SQLite tables or Markdown targets. Discovery and validation perform no native reads or permission requests. The first extraction requests permission if undecided, waiting up to 30 seconds. Denied, restricted, pending, and revoked access throw `RemindersUnavailableError`, retaining the process error as its cause. Asynchronous fetches time out after 60 seconds and cancel the request. A nil fetch result is an error; only a successful empty array can clear a target. Failed reads preserve the previous contents of the affected target.

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

Date components preserve undefined values as `null`, including missing clock components for date-only reminders. A null time zone means a floating date/time; it is never silently replaced with UTC. Start, due, and item time zones remain separate. No UTC due instant is invented from a date-only or floating reminder. `dayOfYear` is null when unavailable before macOS 15; `repeatedDay` is null when unavailable before macOS 26. Native timestamp properties remain UTC ISO strings. Missing start/due properties produce no component row.

Native enum values remain integers. Alarm proximity is `0` (none), `1` (arrival), or `2` (departure); a radius of `0` asks the system to choose a radius. Recurrence frequency is `0` (daily), `1` (weekly), `2` (monthly), or `3` (yearly). A zero recurrence count means no count-based limit. Only the next incomplete reminder in a recurring series is exposed by Apple; the source does not invent future occurrences or deliver notifications.

**Migration from the scripting source:** identifiers now use EventKit's namespace and the source identity is `apple-reminders:eventkit`. `containerId` is replaced by `listId` on reminders and `accountId` on lists. `dueAt`, `allDayDueDate`, and `remindAt` are replaced by date-component and alarm streams; `color` is represented by sRGB components. Flags, parent-reminder/list hierarchy, and list emblems are removed because the inspected public EventKit API does not expose them. Native tags and attachments are also unavailable. Use a fresh SQLite database or new table names and update explicit column projections: overwrite replaces rows but does not migrate old table schemas. Start with a full overwrite of managed Markdown targets so old IDs are not mixed with new ones.

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

`startAt`, `endAt`, and other timestamps retain native instants as UTC strings. For all-day events, `startDate` and exclusive `endDate` separately preserve the local Gregorian dates in EventKit's default time zone. A null `timeZone` remains null; it is not replaced with UTC. Timed events have null date-only fields.

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
