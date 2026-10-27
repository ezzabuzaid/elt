# @workspace/source-apple-messages

An ELT source for Apple Messages. It reads the database of Messages, `~/Library/Messages/chat.db`, in read-only mode through `@workspace/sdk-apple-messages`. It does not use the network, and Messages does not have to be open.

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
import { AppleMessagesSource } from '@workspace/source-apple-messages/apple-messages-source';

const source = new AppleMessagesSource();
const destination = new SQLiteDestination({
  path: './outputs/messages.sqlite',
});
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
      name: 'apple-messages',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './outputs/messages-state.sqlite',
      }),
      steps: [
        ...[
          source.chats,
          source.messages,
          source.chatMessages,
          source.messageAttachments,
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

The `attachments` copy stores each file in `files` and keeps its reference in `attachmentRef`. The `attachment_text` dataset reads the text of the stored files after each pass. A `MacOSDocumentParser` without more formats reads documents and vCards only. To read text in images and voice messages, give it an `ImageFormat` and an `AudioFormat` (see [`@workspace/source-apple-macos`](../macos/README.md)).

## Streams

All columns of the Messages tables load, in camelCase (`is_from_me` becomes `isFromMe`). A foreign `ROWID` becomes the `guid` of the related row.

| Stream                    | Key                                     | Contents                                                                                                            |
| ------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `chats`                   | `guid`                                  | Each chat: identifier, service, display name, flags and properties.                                                 |
| `handles`                 | `id`, `service`                         | Phone numbers and email addresses for each service.                                                                 |
| `chatLookups`             | `identifier`, `domain`                  | The identifiers that Messages resolves to each chat.                                                                |
| `chatServices`            | `chatGuid`, `service`                   | The services of each chat.                                                                                          |
| `chatHandles`             | `chatGuid`, `handleId`, `handleService` | The participants of each chat.                                                                                      |
| `messages`                | `guid`                                  | Each message: text, direction, times, reactions, replies, effects and flags.                                        |
| `chatMessages`            | `chatGuid`, `messageGuid`               | The chat of each message.                                                                                           |
| `linkPreviews`            | `messageGuid`                           | The rich link that a URL message shows.                                                                             |
| `messageEdits`            | `messageGuid`, `partIndex`, `version`   | Each version of an edited message part. Version 0 is the original.                                                  |
| `recoverableMessages`     | `chatGuid`, `messageGuid`               | Recently Deleted: the chat of a deleted message and its delete date.                                                |
| `recoverableMessageParts` | `chatGuid`, `messageGuid`, `partIndex`  | The deleted parts of a message.                                                                                     |
| `attachments`             | `guid`                                  | Each attachment: path, transfer name, MIME type, size, dates and `availableLocally`. This stream can give the file. |
| `messageAttachments`      | `messageGuid`, `attachmentGuid`         | The message of each attachment.                                                                                     |

All streams are snapshot streams. Use `incremental` with `append_dedup` and no `cursorField`.

## Access

Give **Full Disk Access** to the process that runs the pipeline, for example the terminal. If `chat.db` is missing or the process has no access, the read fails with `MessagesUnavailableError` before a copy starts. If `chat.db` does not have a column that the reader uses, for example after a macOS release changes the layout, the read fails with `MessagesSchemaError`. This error names each missing `table.column`.

## Scope

`new AppleMessagesSource(path, scope)` narrows the import. `collectionIds` selects chats by `guid`, and `accountIds` selects chats by their `account_id`. `startAt` (inclusive) and `endAt` (exclusive) select messages by their date. If you omit a key, the source reads all.

## Limitations

- Each run reads all rows, because `chat.db` has no modification time. A run loads the changed rows and deletes the rows that disappeared.
- Recent macOS versions keep the message body only in `attributedBody`. `text` uses the first string of that value.
- `date_edited` does not show edits reliably. Use `messageEdits` for the edit history.
- A file that iCloud offloaded has `availableLocally: false`, and its file fields are null. The source cannot download it. When Messages downloads it, the next run loads it.
- The source does not read the iCloud sync tables, for example `deleted_messages` and `sync_*`.

See [docs/reference.md](../../../../docs/reference.md#apple-messages) for the details.
