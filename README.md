# mac-elt

Extract Apple Notes and Apple Reminders into SQLite or Markdown with immutable `Copy` declarations composed in a `Pipeline`. Extraction includes explicitly selected document parsing for Notes attachments. Loading belongs here; arbitrary transformations and querying stay in your destination.

[Sync decisions and verification](tmp/plans/sync-modes.md) · [Attachment declaration decisions and verification](tmp/plans/attachment-declarations.md) · [Earlier Airbyte API discussion](docs/plans/airbyte-sync-api.md)

```ts
import { Copy } from './src/core/copy.ts';
import { Pipeline } from './src/core/pipeline.ts';
import { SQLiteDestination } from './src/destinations/sqlite/sqlite-destination.ts';
import { AppleNotesSource } from './src/sources/apple-notes/apple-notes-source.ts';
import { SQLiteCheckpointStore } from './src/state/sqlite-checkpoint-store.ts';

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

This polling source has no deletion events or consistent database snapshot. Incremental loading does not remove deleted notes, and it can miss late/backdated changes whose timestamps precede the watermark. Use full refresh overwrite when you need to reconcile the current snapshot. These are source limitations, not deduplication behavior.

## Attachment files and document parsing

```ts
import { MacOSDocumentParser } from './src/parsers/macos-document-parser.ts';

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
import { FileRead } from './src/core/file-read.ts';

new Copy(notes.attachments, markdown.folder('attachments', {
  fields: [new FileRead('content', notes.attachments.file, new MacOSDocumentParser())],
}));
```

Markdown accepts parsed text fields and rejects unparsed binary requests before I/O. Its `file()` target supports the same options as `folder()`.

This follows Airbyte's source-side parser and staged-file concepts: its [file parser Strategy](https://github.com/airbytehq/airbyte-python-cdk/blob/f77450f74def59598cda8e1e9a4e975031710c18/airbyte_cdk/sources/file_based/file_types/file_type_parser.py) interprets files, while [file transfer](https://docs.airbyte.com/platform/using-airbyte/sync-files-and-records) moves original content with metadata. Our parser emits plain text, not Airbyte's Markdown conversion, and we do not claim its complete format/OCR support or wire compatibility.

`MacOSDocumentParser` uses native PDFKit for PDFs with a text layer and native `textutil` for TXT, Markdown, RTF, HTML, DOC, DOCX, ODT, and WordML. It selects the format from the filename extension, preserves text/Markdown content, and strips rich formatting when converting other formats to plain text. HTML conversion does not load external resources. Images, PowerPoint, OCR, locked PDFs, and files without a supported extension are not supported. PDFs with no extractable text and corrupt or unsupported documents fail the copy; there is no implicit skip policy. PDF parsing uses the existing OSA command's 64 MiB output buffer and 120-second timeout. Text conversion uses Node's native `execFile` defaults (1 MiB output limit and no timeout).

Notes exports through its public scripting `save` command into a disposable staging directory. We never read its private database or treat an attachment's URL as a download URL. URL attachments and attachments inside password-protected notes retain metadata with null content/bytes. Other export errors fail the copy, including Notes objects that its save API cannot export. An unnamed attachment can be requested as an original file, but the native parser cannot choose its format without an extension. Sources do not invent missing filenames or claim an unsuccessful export succeeded.

`Source.read()` is the shared template method. Source implementations provide protected `extract(configuration, state)`, yielding metadata, optional staged file paths, and state. The source resolves `configuration.fileReads` into named text or byte values before yielding records to the destination. Staging paths stay inside extraction; writers reject any leaked path. The source cleans staging on success, cancellation, and failure. Binary fields hold each complete file in memory; large files require a different storage strategy.

Extend `DocumentParser` with `parse(path): Promise<string>` for another parsing implementation. Give it a stable identity that includes its version and relevant configuration; keep the implementation/configuration immutable and parse without modifying the staged file. A parser does not depend on Notes or SQLite. Parser identity participates in the copy's checkpoint binding; changing it requires a new copy ID or explicit checkpoint reset. Source keys and cursors remain metadata fields, and acknowledgement still waits for complete destination commit.

The loaded `content` can be queried with normal SQL or indexed with SQLite FTS5 in the consuming application. Parsing does not create a search index. No query API or general transformation step is part of this library.

## Execution and failures

`Pipeline.run()` preflights every copy before executing any of them. Unknown streams, unsupported combinations, invalid schema declarations, missing keys/cursors/IDs/state store, and duplicate copy IDs fail without extraction or storage creation. Preflight uses metadata; storage permissions, existing constraints and record values are checked during execution. Standalone `Copy.run(source, destination, checkpoints?)` validates too.

Copies then execute in declaration order. Each SQLite copy opens its own handle and transaction; each Markdown copy stages its complete output. Errors before commit/publication preserve the previous output for that copy. Empty overwrite clears it; empty append preserves existing records. Earlier copies remain committed if a later copy fails. There is no pipeline-wide rollback.

```ts
import { PipelineError } from './src/core/pipeline.ts';

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
import { MarkdownDestination } from './src/destinations/markdown/markdown-destination.ts';

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
import { AppleRemindersSource } from './src/sources/apple-reminders/apple-reminders-source.ts';

const reminders = new AppleRemindersSource();
const sqlite = new SQLiteDestination({ path: './reminders.sqlite' });

await new Pipeline({
  source: reminders,
  destination: sqlite,
  steps: [
    new Copy(reminders.accounts, sqlite.table('accounts')),
    new Copy(reminders.lists, sqlite.table('lists')),
    new Copy(reminders.reminders, sqlite.table('reminders')),
  ],
}).run();
```

All three streams support full refresh, defaulting to overwrite. Discovery is metadata-only. Extraction uses the public Reminders scripting API through the existing OSA transport, including completed reminders. The same streams work with Markdown targets and explicit SQLite projections. Each stream describes `id` as its source key; list `containerId` can reference an account or another list, and reminder `containerId` can reference a list or another reminder.

Reminder records include `name`, nullable `body`, `createdAt`, `modifiedAt`, `completed`, nullable `completedAt`, nullable `dueAt`, nullable `allDayDueDate`, nullable `remindAt`, native `priority` (0–9), and `flagged`. Lists include native `color` and nullable `emblem`.

`allDayDueDate` preserves the native local calendar date as `YYYY-MM-DD`; timestamp fields use UTC ISO strings. Missing values stay `null`. The native all-day date property is also populated for timed reminders, so it does not provide a reliable `isAllDay` flag. Both fields are retained without inferring one from the other or shifting the calendar date through UTC.

Incremental extraction is rejected until native modification-date behavior is verified for completion, reopening, and moves. Full-refresh overwrite reconciles deletions on the next successful copy. There is no cross-stream snapshot or pipeline-wide transaction. This source covers the public scripting fields above; recurrence rules, tags, attachments, and location triggers are not exposed by this implementation.

Open Reminders and allow macOS Automation access for the process running the export. `RemindersUnavailableError` reports a closed or inaccessible app; an explicit permission denial or other scripting failure keeps its original cause. Sandbox restrictions can make a running app appear inaccessible. Failed reads preserve the previous contents of the affected target.

## Running and checking

Use Node.js 26 from the workspace root:

```sh
npm ci
nx run mac-elt:build
node work/dist/src/main.js
node work/dist/src/export-accounts.js
node work/dist/src/export-attachments.js
node work/dist/src/export-reminders.js
nx run mac-elt:typecheck
nx run mac-elt:test
```

The examples write `outputs/apple-notes.sqlite`, `outputs/markdown/`, and `outputs/attachments.sqlite`. `main.ts` loads attachment metadata, parsed text, and original bytes into `raw_attachments`, then queries the attachment content and byte length joined to the containing note's name. Both Notes attachment examples require files supported by the selected native parser; export/parse errors stop them before the query. Notes must be open and macOS automation accessible. Tests use synthetic records, mocked Notes automation, temporary SQLite/Markdown destinations, and real native parsing of synthetic PDF/Word/text documents. They do not read personal Notes data. Use the built JavaScript: Node's default TypeScript stripping does not support the parameter properties used by this project.

The Reminders example writes `outputs/apple-reminders.sqlite`, replacing `raw_accounts`, `raw_lists`, and `raw_reminders` on each run. Open Reminders before running it. Reminders tests use synthetic native-shaped properties and temporary destinations; they do not read or change personal reminders.
