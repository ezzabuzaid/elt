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

A Context Compiler import loads every stream incrementally into its `data.sqlite`. It stores each attachment file in its `files` folder and refers to it by `attachmentRef`.

## Full Disk Access

Messages keeps its history only in `~/Library/Messages/chat.db`. Messages has no public API that reads messages. macOS guards that folder with **Full Disk Access**. macOS checks the grant of the _responsible_ process: the app that runs the pipeline, for example the terminal. Give that app Full Disk Access.

If `chat.db` is missing or the process has no access, the read fails with `MessagesUnavailableError` before a copy starts. The SQLite error is its `cause`. If `chat.db` does not have a column that the reader uses, for example after a macOS release changes the layout, the read fails with `MissingColumnsError`. This error names each missing `table.column`, and no stream of that read loads.

## Streams

All columns of the Messages tables load, in camelCase (`is_from_me` becomes `isFromMe`). A foreign `ROWID` becomes the `guid` of the related row. Archived Foundation values (binary property lists and `NSKeyedArchiver` graphs) load as JSON text, with data as base64 and dates as ISO timestamps. `attributedBody` is a typedstream, and it stays base64.

| Stream                    | Key                                     | Contents                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chats`                   | `guid`                                  | All 28 `chat` columns: identifier, service, display name, group id, style, archived and filtered flags, last read time, and `properties` as JSON.                                                                                                                                                                                                |
| `handles`                 | `id`, `service`                         | Phone numbers and email addresses for each service, with country and person-centric id.                                                                                                                                                                                                                                                          |
| `chatLookups`             | `identifier`, `domain`                  | The identifiers that Messages resolves to each chat, with priority.                                                                                                                                                                                                                                                                              |
| `chatServices`            | `chatGuid`, `service`                   | Each service that a chat uses.                                                                                                                                                                                                                                                                                                                   |
| `chatHandles`             | `chatGuid`, `handleId`, `handleService` | The participants of each chat.                                                                                                                                                                                                                                                                                                                   |
| `messages`                | `guid`                                  | All 100 `message` columns, and the sender and the other handle (`handle`, `handleService`, `otherHandle`, `otherHandleService`): text, direction, sent, read, delivered, edited, unsent, played and recovered times, reactions, replies, effects and flags. `messageSummaryInfo` and `payloadData` load as JSON, and `attributedBody` as base64. |
| `chatMessages`            | `chatGuid`, `messageGuid`               | The chat of each message, with the `messageDate`, `indexState`, `filterAction` and `filterSubAction` of the join.                                                                                                                                                                                                                                |
| `linkPreviews`            | `messageGuid`                           | The rich link that a URL message shows, from its `payloadData` archive: `url`, `originalUrl`, `title`, `summary`, `siteName`, `itemType`, `creator`, and the whole `LPLinkMetadata` as JSON.                                                                                                                                                     |
| `messageEdits`            | `messageGuid`, `partIndex`, `version`   | Each version of an edited message part, oldest first, from `messageSummaryInfo.ec`: `editedAt`, the decoded `text`, and the raw entry as JSON. Version 0 is the original.                                                                                                                                                                        |
| `recoverableMessages`     | `chatGuid`, `messageGuid`               | Recently Deleted: the chat of a deleted message and its `deleteDate`. Messages keeps the row in `messages` and removes it from `chatMessages`.                                                                                                                                                                                                   |
| `recoverableMessageParts` | `chatGuid`, `messageGuid`, `partIndex`  | The deleted parts of a message, with `partText`.                                                                                                                                                                                                                                                                                                 |
| `attachments`             | `guid`                                  | All 25 `attachment` columns (path, transfer name, MIME type, UTI, size, dates, flags, archived info as JSON) and `availableLocally`. This stream can give the file.                                                                                                                                                                              |
| `messageAttachments`      | `messageGuid`, `attachmentGuid`         | The message of each attachment.                                                                                                                                                                                                                                                                                                                  |

All streams are [snapshot streams](../../../elt/README.md). Use `incremental` with `append_dedup` and no `cursorField`.

The source does not read the iCloud sync and task bookkeeping: `deleted_messages`, `sync_*`, `kvtable`, `persistent_tasks`, `message_processing_task`, `index_state_metrics` and `_SqliteDatabaseProperties`.

## How the source reads chat.db

- **Consistency:** all streams of a run read through one [read context](../../../elt/README.md), which is a read transaction on `chat.db`. The database uses WAL mode. Thus all streams see one snapshot, also while Messages writes.
- **Identity:** rows and relationships use `guid`s. A `ROWID` is local, and it changes when Messages in iCloud builds the database again.
- **Incremental:** edits, unsends and read receipts change old rows, and `chat.db` keeps no modification time. `date_updated` is new in macOS 27, but it is 0 or NULL on each row of the verified history. Thus each run reads all rows, loads the changed rows, and deletes the rows that disappeared ([ADR 0001](./docs/adr/0001-chat-db-is-read-as-a-snapshot.md)).
- **Text:** recent macOS versions keep the body only in `attributedBody`, an `NSAttributedString` in typedstream form. If `message.text` is NULL, `text` takes the first string of that value. The archived value stays as it is.
- **Edits:** `date_edited` does not show edits reliably. In the verified history, Messages left it empty on edited messages. `messageEdits` reads the edit history itself.
- **Times:** `chat.db` counts time from 2001-01-01 UTC. Message dates are in nanoseconds. Attachment dates, edit entries and older histories are in seconds. Both kinds become UTC timestamps, and `0` becomes null.
- **Attachments:** the source reads a file from its original path. It does not copy the file to staging. A file that iCloud offloaded has `availableLocally: false` and null file fields. No public API downloads it. When Messages downloads it, the flag changes, and the next run loads its bytes.
- **Watching:** Messages writes through a WAL that it keeps open, and FSEvents reports such a file only when it closes. Thus `observe()` reads `PRAGMA data_version` on its own read-only connection each second. Each commit changes it, also the commit when an attachment download ends ([ADR 0002](./docs/adr/0002-a-watch-polls-the-data-version-of-chat-db.md)).

## Scope

`new AppleMessagesSource(path, scope)` narrows the import. `collectionIds` selects chats by `guid`, and `accountIds` selects chats by their `account_id`. `startAt` (inclusive) and `endAt` (exclusive) select messages by their date. If you omit a key, the source reads all.

## Limitations

- Each run reads all rows, because `chat.db` has no modification time. A run loads the changed rows and deletes the rows that disappeared.
- Recent macOS versions keep the message body only in `attributedBody`. `text` uses the first string of that value.
- `date_edited` does not show edits reliably. Use `messageEdits` for the edit history.
- A file that iCloud offloaded has `availableLocally: false`, and its file fields are null. The source cannot download it. When Messages downloads it, the next run loads it.
- The source does not read the iCloud sync tables, for example `deleted_messages` and `sync_*`.

## Live checks

The live check ran on **2026-09-25** (macOS 26.6.2, Node.js 26.8.1). A launchd job ran the exporter for a `node` binary with Full Disk Access. The history had 12,567 messages, 468 chats, 472 handles and 41 attachments. The probes read only the schema, counts and aggregates. No message content left the Mac or went into the repository. The test fixture uses the captured table definitions with synthetic rows. `plutil` and `NSKeyedArchiver` encode its archives.

- **Schema:** the source exports each column of the eleven tables, as `PRAGMA table_info` shows. `handle` is `UNIQUE (id, service)`, `chat_lookup` is `UNIQUE (identifier, domain)`, and `chat_service` is `UNIQUE (service, chat)`. No `guid` occurs two times. The flags that the source reads as non-null booleans have no nulls.
- **macOS 27.0** (2026-10-06): `chat.db` got twelve new columns, and the source exports all of them: `message.filter_action`, `filter_sub_action`, `is_preview_sent`, `is_preview_delivered`, `date_preview_sent`, `date_preview_delivered`, `date_updated` and `retry_count`; `attachment.preflight_info` and `sensitivity_analysis`; `chat_message_join.filter_action` and `filter_sub_action`. Each value in this history is 0 or NULL. Thus their kinds and meanings come from the code of Messages in the macOS 27.0 shared cache. That code logs the filter codes and the retry count as integers, and the three dates as it logs `date` and `date_delivered`. `filter_action` and `filter_sub_action` are the action and sub-action of a message filter. Its SMS sub-actions include Transactional, Promotional and Finance. A trigger of Messages copies them into `chat_message_join`. `retry_count` counts send retries. `sensitivity_analysis` is a Communication Safety analysis. Apple does not document the meaning of the preview columns, `date_updated` and `preflight_info`, and the code does not show it. A `chat.db` without these columns, as macOS 26 writes it, fails with `MissingColumnsError`. The other eight tables did not change. The test fixtures use the macOS 27.0 definitions.
- **Access:** a read-only open works while Messages holds the WAL (`chat.db` 34.8 MB, `-wal` 424 KB).
- **Text:** 11,435 messages (91%) keep their body only in `attributedBody`. All 12,567 archived bodies decode. In the 1,132 rows that also have `text`, the decoded string is the same as `text`.
- **Archives:** each stored archive is a binary property list (12,545 `message_summary_info`, 24 `payload_data`, 212 chat `properties`, attachment info), and each decodes. `plutil` and the decoder agree on a real key that contains a control character (`cmmS\u0010`).
- **Edits:** 3 messages have an edit history with 2 versions each, but their `date_edited` is null. The time of version 0 is the same as the `date` of the message.
- **Link previews:** 22, all with URL, original URL and title. 16 have a summary and 17 have a site name.
- **Times:** message times are in nanoseconds (2017 to 2026). Attachment `created_date` and edit times are in seconds. All convert.
- **Runs:** all streams load in approximately 1 s without attachment parsing, and in 5.5 s with it. A second run writes nothing, and five more runs of another session also wrote nothing. Each join row and Recently Deleted row refers to a loaded message, chat and attachment. The snapshot state is approximately 2.6 MB of JSON.
- **Recently Deleted:** 3 messages, each loaded with its chat in `recoverableMessages`. 88 other messages belong to no chat, and they load without one.
- **Attachments:** 6 are on disk, and iCloud offloaded 32. The stored chunks of the 6 files total 702,104 bytes, which is their exact `totalBytes`. They are group photos and link preview images. Vision found text in one.

## Decisions

- [ADR 0001](./docs/adr/0001-chat-db-is-read-as-a-snapshot.md): `chat.db` is read as a snapshot.
- [ADR 0002](./docs/adr/0002-a-watch-polls-the-data-version-of-chat-db.md): a watch polls the data version of `chat.db`.
