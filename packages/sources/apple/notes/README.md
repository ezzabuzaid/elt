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

The `attachments` copy stores each file in `files` and keeps its reference in `attachmentRef`. The `attachment_text` dataset reads the text of the stored files after each pass. See [attachment text](../../../../docs/reference.md#attachment-text) and [derived datasets](../../../../docs/reference.md#derived-datasets).

## Streams

| Stream              | Key    | Contents                                                                                                                                                                                   |
| ------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `accounts`          | `[id]` | The name and the numeric account `type` of Notes.                                                                                                                                          |
| `folders`           | `[id]` | The account, the parent folder, the name, the `type` (`1` is Recently Deleted), the query of a smart folder, and the shared flag.                                                          |
| `notes`             | `[id]` | The folder, the account, the title, plain `text`, `markdown`, the times, and the flags of Notes (pinned, checklist, locked, shared).                                                       |
| `inlineAttachments` | `[id]` | Tags, mentions, links to other notes and calculation results, with the text that the note shows and the target.                                                                            |
| `attachments`       | `[id]` | The type, the title, the file name, recognized text, the audio transcript, the size, the dimensions, the location, the times and `availableLocally`. This stream can give the file itself. |

All streams are snapshot streams. Use `incremental` with `append_dedup` and no `cursorField`.

## Access

Give **Full Disk Access** to the process that runs the pipeline. If the store is missing or the process has no access, the read fails with `NotesUnavailableError`. If the store does not have a column that the reader uses, for example after a macOS release changes the layout, the read fails with `MissingColumnsError`. This error names the missing columns.

## Scope

`new AppleNotesSource({ scope })` narrows the import. `accountIds` selects accounts, `collectionIds` selects folders, and `startAt` (inclusive) and `endAt` (exclusive) select notes by their modification time. If you omit a key, the source reads all.

## Limitations

- Each run reads the full store, writes only new and changed records, and deletes records that disappeared.
- Notes in Recently Deleted stay in the export until Notes deletes them permanently.
- A note that Notes has not downloaded from iCloud yet has no folder, title or dates. The source does not load it until it arrives.
- A locked note keeps its title, dates and flags. Its text and Markdown do not load, and its attachments keep only their type, name, size and times.
- An attachment that Notes has not downloaded has `availableLocally: false`, and its file fields are null.
- Only Notes syncs iCloud notes on the Mac. While Notes is closed, the store holds what Notes synced last. A watch (`pipeline.watch()`) launches Notes hidden, and launches it again every 30 seconds if it stopped.

See [docs/reference.md](../../../../docs/reference.md#apple-notes-behavior) for the details.
