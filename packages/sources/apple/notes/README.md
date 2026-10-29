# @workspace/source-apple-notes

An ELT source for Apple Notes. It reads the Core Data store of Notes, `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`, in read-only mode through `@workspace/sdk-apple-notes`. It does not use the network, and Notes does not have to be open.

```ts
import {
  Connection,
  Copy,
  DocumentText,
  LocalFiles,
  Pipeline,
} from '@workspace/elt';
import {
  ComputedDataset,
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { MacOSDocumentParser } from '@workspace/source-apple-macos/macos-document-parser';
import { AppleNotesSource } from '@workspace/source-apple-notes/apple-notes-source';

const source = new AppleNotesSource();
const destination = new SQLiteDestination({ path: './outputs/notes.sqlite' });
const files = new LocalFiles({ directory: './outputs/files' });
const parser = new MacOSDocumentParser();
const attachments = destination.table('attachments', (columns) => [
  ...SQLiteColumns.fromSchema(source.attachments.jsonSchema),
  columns.text('attachmentRef').from(source.attachments.file.store(files)),
]);
const options = {
  syncMode: 'incremental',
  destinationSyncMode: 'append_dedup',
} as const;

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'apple-notes',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './outputs/notes-state.sqlite',
      }),
      steps: [
        ...[
          source.accounts,
          source.folders,
          source.notes,
          source.inlineAttachments,
        ].map(
          (stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: stream.name,
              ...options,
            }),
        ),
        new Copy(source.attachments, attachments, {
          id: 'attachments',
          ...options,
        }),
      ],
    }),
  ],
  derived: [
    new ComputedDataset({
      into: destination,
      name: 'attachment_text',
      description: 'The text of each stored attachment.',
      from: [attachments],
      compute: new DocumentText({
        parser: () => parser,
        files: files.directory,
        column: 'attachmentRef',
      }),
    }),
  ],
}).run();
```

The `attachments` copy stores each file in `files` and keeps its reference in `attachmentRef`. The `attachment_text` dataset reads the text of the stored files after each pass. See [attachment text](../../../../docs/reference.md#attachment-text) and [computed datasets](../../../destinations/sqlite/README.md#declare-a-computed-dataset).

## Streams

The source reads the store of Notes through its SDK, `@workspace/sdk-apple-notes`. Each run reads each selected stream in one SQLite read transaction, so notes, attachments and folders come from the same moment. Note bodies are gzipped protobuf documents, and tables are gzipped CRDT documents. The SDK decodes the two in the process.

| Stream              | Key    | Contents                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`          | `[id]` | The name and the numeric account `type` of Notes.                                                                                                                                                                                                                                                                                                                            |
| `folders`           | `[id]` | The account, the parent folder (folders can nest), the name, the `type` (`1` is Recently Deleted), the query of a smart folder, and whether it is shared.                                                                                                                                                                                                                    |
| `notes`             | `[id]` | The folder, the account, the title, plain `text`, `markdown`, the created and modified times, `pinned`, the `hasChecklist` and `checklistInProgress` flags of Notes, `locked` and `shared`.                                                                                                                                                                                  |
| `inlineAttachments` | `[id]` | Tags, mentions, links to other notes and calculation results, as Notes stores them. `type` is the identifier of Notes (for example `com.apple.notes.inlinetextattachment.hashtag`). `text` is what the note shows (`#travel`). `target` is what it points at: the normalized name of a tag (`TRAVEL`), or for a link to a note, the `applenotes:note/<id>` URL of that note. |
| `attachments`       | `[id]` | The type identifier, the title, the file name, the URL, the summary of Notes, the recognized text (`ocrText`, `handwritingText`), image labels, the audio `transcript`, the size, the duration, the dimensions, the location, the times and `availableLocally`. This stream can give the file itself.                                                                        |

The content of a note is in one place, its `markdown`. Checklists show as `- [x]` items, and tables as Markdown tables, where they are in the note. They are not separate streams.

`markdown` shows the paragraph styles and runs of Notes:

- Title, Heading and Subheading become `#`, `##` and `###`.
- Bullet, dashed, numbered and checklist lists keep their indentation.
- Monospaced becomes fenced code. Block quotes, bold, italic, strikethrough and links keep their Markdown form.
- Underline, fonts and colors have no Markdown form, and the source drops them.
- A table shows where it is in the note. An inline tag or mention shows as its text. A link to a note becomes `[title](<applenotes:note/…>)`. A file becomes `[name](attachment:<id>)`, which names its `attachments` row.

`text` is the visible text of the note. It keeps inline tags and mentions, and it removes the placeholders of files.

All streams are [snapshot streams](../../../elt/README.md#snapshot-streams). Use `incremental` with `append_dedup` and no `cursorField`. The key of the stream is the key of the copy. Each run reads the full store, writes only new and changed records, and deletes records that disappeared, also rows that Notes marks for deletion. A read costs little: the store is local SQLite, so a run over thousands of notes takes milliseconds before the decode.

## Access

Give **Full Disk Access** to the process that runs the pipeline. If the store is missing or the process has no access, the read fails with `NotesUnavailableError`. This is a `config` failure.

The layout of the store changes between macOS releases. The SDK reads the layout of macOS 26, and it checks each column that it uses when it opens the store. If the store does not have a column, the read fails with `MissingColumnsError`, which names the missing columns. The source does not load fields from the wrong place.

## Scope

`new AppleNotesSource({ scope })` narrows the import. `accountIds` selects accounts, `collectionIds` selects folders, and `startAt` (inclusive) and `endAt` (exclusive) select notes by their modification time. If you omit a key, the source reads all. The coverage of each stream is `localAppleStoreCoverage` of `source-apple-macos`, with the scope as its selection.

## Watch

Only Notes syncs iCloud notes on the Mac. While Notes is closed, the store holds what Notes synced last. Edits on other devices get to the store the next time that Notes runs. Thus a watch (`pipeline.watch()`) keeps Notes running.

- The watch opens its own read-only connection to `NoteStore.sqlite` and checks `PRAGMA data_version` every second. The value changes with each commit of a different connection, so each save that Notes commits marks each selected stream as changed. A check with no commit yields no stream.
- The watch does not use file system notices. Notes keeps the store and its WAL open, and FSEvents reports a write only when the file closes. The live check showed that the event comes when Notes quits.
- The watch launches Notes hidden and in the background (`open -g -j`) when it starts, and again every 30 seconds if Notes stopped. It cannot tell a quit by the user from macOS closing a hidden Notes. macOS does that when it frees disk space (seen two times on a disk that was 99% full, minutes after a hidden launch). Thus the watch launches Notes again in the two cases.
- A Notes that runs stays as it is, because `open -j` would hide a window that the user has open.
- A watch needs the same Full Disk Access as a read.

`currentAsOf` is the last write of `NoteStore.sqlite` while Notes is closed, and `null` while Notes runs. See [how current a stream is](../../../elt/README.md#how-current-a-stream-is).

## Limitations

- Notes in Recently Deleted are notes in that folder. They stay in the export until Notes deletes them permanently.
- A note that Notes listed but did not download from iCloud yet has no folder, title or dates. The source does not load it until it arrives.
- A locked note keeps its title, dates and flags. Its text and Markdown do not load, and its attachments keep only their type, name, size and times.
- An attachment that Notes has not downloaded has `availableLocally: false`, and its file fields are null.

## Live checks

On 2026-09-25, with macOS 26.6.2 and Node.js 26.8.1, against the real store with Notes closed, and with Full Disk Access for the process:

- Without Full Disk Access, the process cannot list the group container (`EPERM`). With it, the store opens read-only while Notes is closed or runs.
- Only Notes writes note and iCloud sync data: each persistent-history transaction on note, folder, account and server-change-token entities came from `com.apple.Notes`. With Notes closed, the store does not change. An edit on an iPhone got to the store only after a hidden launch of Notes, and the watch loaded it less than one second after Notes committed it.
- Recursive file system notices on the container did not report the WAL writes of Notes while Notes ran. The event came when Notes quit. A poll of `data_version` for each commit saw each commit.
- A hidden launch (`open -g -j`) kept the front app in front and put no window of Notes on the screen, and Notes synced when it started. macOS closed the hidden Notes two times in minutes to free disk space on a disk that was 99% full. The watch launched it hidden again on its next check.
- The exporter loaded each stream. A second run with no changes wrote nothing. Temporary notes that were made for the probe (formatted text, a table, and PNG, PDF, M4A, TXT and ZIP attachments) agreed with what was made: headings and emphasis, lists, the cells of the table, the bytes of each file, and the text that was parsed from the PDF and the TXT.
- Ten note rows of the store were placeholders of notes that Notes had not downloaded from iCloud yet (no folder, title or dates). The export leaves them out, and then it agrees with what Notes shows.
- A Markdown file imported into Notes gave real Title, Heading, Subheading, checklist (one done, one open), Monospaced, block quote and table formats. The export gave each its Markdown form, and set `hasChecklist` and `checklistInProgress`. A hashtag typed into a note became an `inlineAttachments` row (`#macEltTag`, target `MACELTTAG`), and it showed in the `text` and `markdown` of the note. The watch loaded each edit seconds after Notes saved it.
- A link to a note, made with the `>>` picker of Notes, became an `inlineAttachments` row of the type `com.apple.notes.inlinetextattachment.link`. Its target is the `applenotes:note/<id>` URL of the linked note, and `markdown` shows it as a Markdown link. A pasted web address became a link in the text.
- The probe notes and folders were deleted after the check and removed from Recently Deleted. The store then marked them for deletion.

Not checked live, each for a reason:

- **Audio recordings and transcripts, locked notes, rich previews of web links:** Notes keeps Record Audio, Lock Note and Share disabled unless a person has the focus on the note, so scripts cannot start them. A lock also needs the Notes password.
- **Scans and sketches:** Notes on the Mac inserts them only from the camera or pencil of an iPhone or iPad.
- **Mentions:** they exist only in a note that is shared with a different iCloud user.
- **Locations:** a user adds them only through the share sheet of Maps.

Checklists, tags, tables and a locked note were also read from sample stores of macOS 26 that Apple made. The kinds that were not checked are read as the published format describes them. To check one, make it in a Notes folder and import Notes through the Context Compiler CLI.
