# API and behavior reference

[Back to the README](../README.md)

Detailed sync, storage, connector, and failure contracts for `elt`.

## Working example

The working example is in [elt](../packages/elt/README.md#copy-a-stream).

## Sync modes

Sync modes, the dedup policy, deletions, resets, shape changes and target ownership are in [elt](../packages/elt/README.md#sync-modes).

## Identity, cursors, and schemas

Keys, cursors, string formats and names are in [elt](../packages/elt/README.md#keys-cursors-and-schemas). The column types of each destination are in [elt-sqlite](../packages/destinations/sqlite/README.md#columns) and [elt-postgresql](../packages/destinations/postgresql/README.md#columns).

## Incremental extraction and checkpoints

Checkpoints, snapshot streams, partitioned streams and the read context are in [elt](../packages/elt/README.md#incremental-copies-and-checkpoints). Apple Notes is in [source-apple-notes](../packages/sources/apple/notes/README.md), and EventKit reads are in [sdk-apple-eventkit](../packages/sdks/apple/eventkit/README.md).

## Watching for changes

Watching is in [elt](../packages/elt/README.md#watch-for-changes).

## Attachment files and document parsing

```ts
import { LocalFiles } from '@workspace/elt';
import { SQLiteSyncHistory } from '@workspace/elt-sqlite';
import { MacOSDocumentParser } from '@workspace/source-apple-macos/macos-document-parser';

const files = new LocalFiles({ directory: './outputs/attachments' });
const attachmentCopy = new Copy(
  notes.attachments,
  sqlite.table('attachments', (c) => [
    c.text('id'),
    c.text('noteId'),
    c
      .text('content')
      .from(notes.attachments.file)
      .parse(new MacOSDocumentParser()),
    c.text('attachmentRef').from(notes.attachments.file.store(files)),
  ]),
  {
    syncMode: 'full_refresh',
    destinationSyncMode: 'overwrite',
  },
);

await new Pipeline({
  history: new SQLiteSyncHistory(),
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

This stores the selected source metadata, parsed `content` and an `attachmentRef` as TEXT. The original attachment ID and containing note ID remain available for joins. `LocalFiles` stores the original bytes and returns their path relative to its folder (`.elt-files/<scope>/<hash><ext>`), so an import moved with its files keeps every reference, and its identity names no folder. SQLite and Postgres receive only that ordinary text value: they do not construct paths or write attachment files. See [Attachment text](#attachment-text) for search over the stored copies.

Storage is selected on each file reference with `.store(files)`, independently of the connection and destination. Two fields can use different stores, and copies can share one store without sharing file ownership. Constructing a store or declaring a field performs no I/O. A stored reference and parsed text must be separate fields; applying `.parse()` to a stored-file field is refused.

`LocalFiles` resolves the chosen directory at construction. It streams each file in chunks of at most 4 MiB into a temporary file, syncs it, then publishes it atomically. Replication flushes each declared stored-file scope once before its rows commit, rather than flushing the directory for every file. Flushing an absent scope is a no-op. Newly created parent directories are synced when created. Files live in `.elt-files/<scope hash>/<content hash><extension>` beneath that directory. The scope identifies the destination target, copy writer and field; the content hash makes repeated saves stable without overwriting an existing reference. A source extension of 1 to 16 letters or digits is preserved and any other is dropped, by `fileExtension` from `elt`, which sources also use to name the copies they stage; the original filename stays in source metadata. Empty files are real zero-byte files. Unavailable source files produce null references.

The shared transfer saves files before applying records and commits database rows before removing obsolete files. It asks each destination for the references its committed rows actually retain, so a cursor-rejected update cannot delete the winning attachment. Append retains the files of every retained observation; replacement, deletion, empty overwrite and `Copy.clear()` remove files only when this scope no longer references them. Source failures discard pending rows and reconcile against the retained rows.

Files and database rows do not share a transaction. A failed save prevents its rows and checkpoint from advancing. A cleanup failure after a database commit preserves that committed data but prevents the checkpoint from advancing; replay is safe. A failed database write or interrupted run can leave unreferenced files; the next run reconciles them before extraction using the current committed references. Missing referenced files, non-file references and invalid managed directories fail explicitly. Keep these generated files intact until clearing and rebuilding their copy.

For another storage backend, implement the exported `FileStorage` contract: a stable `identity`, a `reference` sentence telling readers what a saved reference is (Postgres writes it as the reference column's comment), `save(scope, FileContent)` returning a complete, immutable, repeatable text reference, `flush(scope)` making completed saves durable before their rows commit and safe to repeat even for a scope with no saves, and `retain(scope, references)` removing only that scope's unreferenced objects. Identity participates in the copy's checkpoint binding. The transfer treats references as opaque strings, so a future S3 store can return its own reference format without changing database destinations. Only `LocalFiles` is supplied today. Reconciliation scans retained references and the scoped directory at each commit; it does not maintain a separate object index.

The columns declare what to extract. `Copy` collects those declarations; `Source.read()` performs parsing and exposes original files as a `FileContent`, valid until its record is consumed. The shared transfer resolves stored-file declarations before sending records to the destination. Omitting a stored reference avoids retaining the original file; omitting all file-derived columns avoids exporting files altogether.

### Attachment text

A copy can store files with no parse: an `attachmentRef` column and no `content` column. The import then never waits on parsing, and a file the parser cannot read fails no copy. Text read from the stored copies afterwards is derived data, not a source: its input is what the pipeline wrote. Declare it as a [computed dataset](../packages/destinations/sqlite/README.md#declare-a-computed-dataset) with the `DocumentText` rule; the pipeline reads the files after each pass. [Context Compiler](https://github.com/ezzabuzaid/context-compiler/blob/main/docs/connectors-and-hosts.md) keeps an `attachment_text` view this way, which SQL joins on `attachmentRef = ref`:

```sql
SELECT a.id, t.content
FROM attachments a JOIN attachment_text t ON t.ref = a.attachmentRef
WHERE t.content LIKE '%invoice%';
```

A stored copy is content-addressed within its field, so one file attached in three chats is one copy; the same bytes stored by two streams are two copies. A parser whose identity changes reads the copies it handles again; a format the parser stops handling keeps the text it read.

### Explicit database byte storage

Use `c.blob('bytes').from(notes.attachments.file)` when the database should own the original bytes instead. This is independent of `.store(files)` and remains available for both SQL destinations. The file and row then commit together in the database.

SQLite stores an original file in chunks, because one BLOB is capped at 1,000,000,000 bytes (`SQLITE_MAX_LENGTH` in Node's build) and a whole-file value would sit in memory. The `bytes` column holds an INTEGER file id, and a per-column `_elt_files_<hash>` table holds `(file, n, bytes)` rows of up to 4 MiB, `n` counting from 0. The hash is the first 40 hex characters of SHA-256 over `JSON.stringify([table, column])`, with both names in ASCII lower case, so table `a_b` with column `c` and table `a` with column `b_c` keep their chunks apart. The column's description names its chunk table. An empty file has one empty chunk. Triggers remove a row's chunks in the same transaction whenever the row is deleted, overwritten or replaced, and a record that a deduplication guard rejects stores none. Read a file back in order, with the chunk table the description names:

```sql
SELECT c.bytes FROM "_elt_files_<hash>" AS c
WHERE c.file = (SELECT bytes FROM attachments WHERE id = ?)
ORDER BY c.n;
```

Verified on 2026-09-24 (macOS 26.6.2, Node.js 26.8.1): a 1.5 GB file loaded as 358 chunks in 3.3 s with a peak RSS of 137 MiB, and the reassembled chunks matched the file's SHA-256.

Postgres supports the same `text().from(file).parse(parser)` and `blob().from(file)` declarations. Parsed content is TEXT. An original file's column holds a UUID; its bytes live in a per-column `_elt_files_<hash>` table in the destination schema, with `(file UUID, n BIGINT, bytes BYTEA)` chunks of up to 4 MiB. The hash is the first 40 hex characters of SHA-256 over `JSON.stringify([tableName, columnName])`. Join the file UUID and order by `n` to read the original. Empty files have one empty chunk; unavailable files have a null reference. The loader removes unreferenced chunks when a stage commits or is discarded, and when it reopens after a crash; clearing a copy removes its files too. A plain `blob()` column without `.from(file)` stores an inline BYTEA value.

```ts
// Text only, under a destination field name you choose.
new Copy(
  notes.attachments,
  sqlite.table('attachment_text', (c) => [
    c.text('id'),
    c
      .text('search_text')
      .from(notes.attachments.file)
      .parse(new MacOSDocumentParser()),
  ]),
);

// Original bytes only; no parser runs.
new Copy(
  notes.attachments,
  sqlite.table('originals', (c) => [
    c.text('id'),
    c.blob('bytes').from(notes.attachments.file),
  ]),
);
```

A bare table still infers the discovered metadata schema. To include all metadata alongside file-derived columns, spread `SQLiteColumns.fromSchema(notes.attachments.jsonSchema)` into the columns array. A plain `c.blob('bytes')` reads a record's existing `bytes` field into an inline BLOB. `.from(file)` selects the original source file; `.parse(parser)` requests its text representation. Original bytes require a BLOB column; parsed text and stored-file references require TEXT. The existing `.notNull()` and `.primaryKey()` constraints apply to these fields. Incompatible types, another stream's file reference, and fields colliding with source metadata or `loaded_at` fail before extraction.

`notes.attachments.file` is an immutable source reference, not a path. Other Notes streams reject file access. All declarations remain immutable and perform no I/O; the discovered source schema is never rewritten to describe destination fields. A file can supply multiple named representations in one copy. Each record is exported once; requests using the same parser instance share one parse, and original-byte requests share one read. Separate copies retain separate extraction and checkpoint progress.

This follows Airbyte's source-side parser and staged-file concepts: its [file parser Strategy](https://github.com/airbytehq/airbyte-python-cdk/blob/f77450f74def59598cda8e1e9a4e975031710c18/airbyte_cdk/sources/file_based/file_types/file_type_parser.py) interprets files, while [file transfer](https://docs.airbyte.com/platform/using-airbyte/sync-files-and-records) moves original content with metadata. Our parser emits plain text, not Airbyte's Markdown conversion, and we do not claim its complete format/OCR support or wire compatibility.

`MacOSDocumentParser` uses native PDFKit for PDFs with a text layer and native `textutil` for TXT, Markdown, RTF, HTML, DOC, DOCX, ODT, and WordML. It selects the format from the filename extension, preserves text/Markdown content, and strips rich formatting when converting other formats to plain text. HTML conversion does not load external resources. Images (JPEG, PNG, GIF, HEIC/HEIF, TIFF, BMP, ICO, WebP) go through Vision's accurate text recognition, one line per observation. ImageIO checks native dimensions first; images narrower or shorter than three pixels return null because Vision crashes or rejects these inputs. Audio transcription is opt-in: pass `new AudioFormat(model)` to the parser, where `model` is a caller-owned AI SDK transcription model. Without it, audio returns null. vCards, including Messages' `.loc.vcf` locations, load as their text. A format claims a file by its extension or by its magic number, the leading bytes that name the format, so a file without a usable extension, such as Messages' `GroupPhotoImage`, is still read; text that merely begins like a magic number, such as `BMW` or `%PDF notes`, is not taken for an image or a PDF. Files that match no format, locked PDFs, PDFs without a text layer and images without recognizable text parse to `null`, so the field loads as null and the copy continues. A file that cannot be read (a PDF that cannot be opened, an image Vision cannot decode, a `textutil` error) fails the copy. The parser identity includes its formats and their configuration; `identityFor(path)` identifies the specific format and model for attachment caching. PDF parsing uses the existing OSA command's 64 MiB output buffer and 120-second timeout. Text conversion uses Node's native `execFile` defaults (1 MiB output limit and no timeout).

`MacOSDocumentParser` accepts additional `DocumentFormat` instances while retaining its built-in document formats. `AudioFormat` calls Vercel AI SDK's `transcribe()` with the supplied model; it owns no credentials or model lifetime. For local inference, `@workspace/transcription-local` implements AI SDK's `TranscriptionModelV4` over a native worker on [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp), which loads a GGUF model and runs it on Metal:

```ts
import {
  Fixed,
  HillClimbing,
  LeaderFirst,
  Parallel,
  Pool,
} from '@zukhruf/pool';

import { AudioFormat } from '@workspace/source-apple-macos/audio-format';
import { ImageFormat } from '@workspace/source-apple-macos/image-format';
import { MacOSDocumentParser } from '@workspace/source-apple-macos/macos-document-parser';
import { VisionWorker } from '@workspace/source-apple-macos/vision';
import { LocalTranscriptionModel } from '@workspace/transcription-local';
import { TranscriptionWorker } from '@workspace/transcription-local/transcription-worker';

const configuration = {
  name: 'cohere-transcribe-arabic-07-2026',
  path: '/path/to/cohere-transcribe-arabic-07-2026-Q8_0.gguf',
  language: 'ar',
};
await using ocr = new Pool({
  size: new HillClimbing({ memoryPerWorker: VisionWorker.memory }),
  startup: new LeaderFirst(),
  create: () => new VisionWorker('/path/to/vision-worker'),
});
await using engines = new Pool({
  size: new Fixed(1),
  startup: new Parallel(),
  create: () =>
    new TranscriptionWorker('/path/to/transcribe-local', configuration),
});
const parser = new MacOSDocumentParser([
  new ImageFormat(ocr),
  new AudioFormat(new LocalTranscriptionModel(configuration, engines)),
]);
const text = await parser.parse('/path/to/voice-message.opus');
```

The host owns the native workers. It builds a `Pool` (`@zukhruf/pool`) for each kind and disposes it, which stops every worker. A pool lends one worker to one read at a time and replaces a worker that died. Its startup decides when workers start: `LeaderFirst` starts the first Vision worker alone, because Vision compiles its models once for each helper binary and caches them, and the other workers read that cache. `Parallel`, `OrderedReady` and `OnDemand` are the other startups. Its sizing decides how many workers run: `Fixed(n)` runs n; `Resources({ memoryPerWorker })` runs one per CPU while each finds its memory free; `HillClimbing` starts with two and adds one while the last added at least a tenth more jobs a second, as the .NET thread pool does; `Gradient` starts with two and adds one while a job takes at most half again the best time, as Netflix's concurrency-limits does. The two that learn measure only while jobs wait and every worker is ready, in windows of at least 20 jobs and 2 seconds. Each step measures the size so far, one more, and the size so far again, and compares one more to the mean of both, so work that changes while it is measured, as when files arrive grouped by kind, does not decide; the worker it tries stays alive between. They learn once per pool and never pass the Mac's capacity. `VisionWorker.memory` is the memory to size a Vision pool by.

The local provider also works directly with `transcribe({ model, audio })`. It converts input with macOS's `afconvert` to 16 kHz mono 32-bit float samples, so a Mac needs nothing installed, and then borrows an engine from its pool, which transcribes one file at a time. `TranscriptionWorker.check(helper)` checks that the engine runs on this Mac without loading weights. Cohere decodes at most 512 tokens in one run, so audio longer than 40 s is cut at pauses found by Silero VAD, which ships inside the worker, into pieces of about 30 s, and each piece is decoded on its own. The transcript has no segments, because Cohere marks no timings. Cancellation stops decoding or inference. `language`, when given, tells the model which language the speech is in; the model id includes it, so a new language reads audio again. `@workspace/sdk-macos-speech-models` lists the speech models installed on this Mac, whichever app or tool installed them: the Hugging Face cache (`~/.cache/huggingface/hub`), where `hf`, Handy and other tools download, and any `.gguf` or `.bin` file Spotlight finds in the home folder. A GGUF counts when its architecture is one Handy's catalog (`@handy-computer/models`) lists for transcription; a `.bin` counts when it is a whisper.cpp model. A model's id is its file name, its title is the catalog's name, the GGUF's own name or the file name, and only Cohere Transcribe Arabic is told a language: Arabic, which also keeps English as spoken. The SDK never downloads or modifies a model.

The caller composes the document parser, with or without an `AudioFormat`. Each format has its own identity, so changing the audio model does not invalidate PDF, image or text extraction. [Context Compiler](https://github.com/ezzabuzaid/context-compiler/blob/main/docs/connectors-and-hosts.md) composes it from its saved transcription choice.

Notes hands over the original file from its store, never a staged copy: `<NoteStore.sqlite directory>/Accounts/<account>/Media/<media>/[<generation>/]<filename>`, from the attachment's media row. An attachment has no file when its note is locked or it has no media row or filename (tables, links, sketches without media); a path that is not on disk (an iCloud file Notes has not downloaded) sets `availableLocally` to false. In each case the metadata loads and the file fields load as null. We never treat an attachment's URL as a download URL or invent a missing filename.

`Source.read()` is the shared template method. Source implementations provide protected `extract(configuration, state, partition, context)`, yielding metadata, optional file paths, and state. The source resolves `configuration.fileReads` into parsed text or a `FileContent` before yielding records to the destination. A path must stay readable until the consumer advances past its record: a staged copy the source cleans up afterwards, or the original file when copying it would be costly (Notes and Messages hand over their attachment files). Destinations reject any leaked path.

Extend `DocumentParser` with `parse(path, signal?): Promise<string | null>` for another parsing implementation. Return `null` when the file has no text the parser can represent, and throw only when reading it failed. Give it a stable identity that includes its version and relevant configuration; keep the implementation/configuration immutable and parse without modifying the file. A parser does not depend on Notes or SQLite. Parser identity participates in the copy's checkpoint binding; changing it requires a new copy ID or explicit checkpoint reset. Source keys and cursors remain metadata fields, and a checkpoint is still acknowledged only after the rows before it commit.

The loaded `content` can be queried with normal SQL or indexed with SQLite FTS5 in the consuming application. Parsing does not create a search index. No query API or general transformation step is part of this library.

## Sources and their hosts

Sources and their hosts are in [elt](../packages/elt/README.md#sources-and-their-hosts) and [apps/google](../apps/google/README.md).

## Execution and failures

Runs, failures and the sync history are in [elt](../packages/elt/README.md#run-and-failures).

## Derived datasets

Derived datasets are documented in their packages. [elt](../packages/elt/README.md) tells when the pipeline refreshes them and how to write a rule. [elt-sqlite](../packages/destinations/sqlite/README.md) tells about `View` and `ComputedDataset`.

## Postgres destination

The Postgres destination is in [elt-postgresql](../packages/destinations/postgresql/README.md), and the warehouse is in [infra](../infra/README.md).

## Apple Messages

Apple Messages is documented in its package: [source-apple-messages](../packages/sources/apple/messages/README.md).

## Apple Mail

Apple Mail is documented in its package: [source-apple-mail](../packages/sources/apple/mail/README.md).

## Apple Contacts

Apple Contacts is documented in its package: [source-apple-contacts](../packages/sources/apple/contacts/README.md).

## Apple Reminders

Apple Reminders is documented in its package: [source-apple-reminders](../packages/sources/apple/reminders/README.md).

## Apple Calendar

Apple Calendar is documented in its package: [source-apple-calendar](../packages/sources/apple/calendar/README.md).

## Apple Safari

Apple Safari is documented in its package: [source-apple-safari](../packages/sources/apple/safari/README.md).

## Apple Books

The Apple Books source is documented in its package: [source-apple-books](../packages/sources/apple/books/README.md).

## Apple Activity

The Apple Activity source is documented in its package: [source-apple-activity](../packages/sources/apple/activity/README.md).

## Apple Accounts

The Apple Accounts source is documented in its package: [source-apple-accounts](../packages/sources/apple/accounts/README.md).

## Apple Call History

The Apple Call History source is documented in its package: [source-apple-call-history](../packages/sources/apple/call-history/README.md).

## Apple Clock

Apple Clock is documented in its package: [source-apple-clock](../packages/sources/apple/clock/README.md).

## Apple Notification Center

The Apple Notification Center source is documented in its package: [source-apple-notification-center](../packages/sources/apple/notification-center/README.md).

## Apple Wallet

The Apple Wallet source is documented in its package: [source-apple-wallet](../packages/sources/apple/wallet/README.md).

## Slack

The Slack desktop source is documented in its package: [source-slack-desktop](../packages/sources/slack/desktop/README.md).

## Microsoft Teams

The Microsoft Teams source is documented in its package: [source-microsoft-teams](../packages/sources/microsoft/teams/README.md).

## WhatsApp

The WhatsApp desktop source is documented in its package: [source-whatsapp-desktop](../packages/sources/whatsapp/desktop/README.md).

## Instagram

The Instagram web source is documented in its package: [source-instagram-web](../packages/sources/instagram/web/README.md).

## Google Search Console

Google Search Console is documented in [source-google-search-console](../packages/sources/google/search-console/README.md). The warehouse that the Google app loads is documented in [elt-postgresql](../packages/destinations/postgresql/README.md).

## Google Health

Google Health is documented in [source-google-health](../packages/sources/google/health/README.md).

## SQL Server

The SQL Server source is documented in its package: [source-microsoft-sql-server](../packages/sources/microsoft/sql-server/README.md).
