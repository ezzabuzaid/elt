# @workspace/source-apple-mail

An ELT source for Apple Mail. It reads the local store of Mail under `~/Library/Mail` (the `Envelope Index` database, the `.emlx` message files and the property lists) through `@workspace/sdk-apple-mail`. It reads the account and server settings from the system Accounts store through `@workspace/sdk-apple-accounts`. It does not use the network.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import {
  AccountsStore,
  accountsStorePath,
} from '@workspace/sdk-apple-accounts';
import { mailDirectory } from '@workspace/sdk-apple-mail';
import { AppleMailSource } from '@workspace/source-apple-mail/apple-mail-source';

const source = new AppleMailSource({
  path: mailDirectory,
  accounts: new AccountsStore(accountsStorePath),
});
const destination = new SQLiteDestination({ path: './outputs/mail.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'apple-mail',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './outputs/mail-state.sqlite',
      }),
      steps: [
        source.mailboxes,
        source.messages,
        source.messageMailboxes,
        source.addresses,
        source.recipients,
        source.messageParts,
      ].map(
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

Give another `path` or another Accounts store path to read a copy of the stores.

## Streams

The source has 42 streams. Each stream is a property of the source, and `discover()` returns all of them.

| Streams                                                                                                                                                         | Data                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `accounts`, `smtpServers`                                                                                                                                       | Account and server settings from the system Accounts store, without secrets.                               |
| `mailboxes`, `mailboxProperties`                                                                                                                                | Mailbox URLs, counts and IDs, and the properties in `.mbox/Info.plist`.                                    |
| `messages`, `subjects`, `summaries`, `generatedSummaries`                                                                                                       | All message columns of the index, subjects, summaries and generated summaries.                             |
| `addresses`, `recipients`                                                                                                                                       | Addresses and the recipients of each message, in order.                                                    |
| `messageMailboxes`, `serverMessages`, `serverMessageMailboxes`                                                                                                  | Local and server mailbox memberships, message state and IMAP identifiers.                                  |
| `conversations`, `conversationMessages`, `messageReferences`, `messageGlobalData`                                                                               | Conversations, reply references and global message status.                                                 |
| `messageMetadata`, `dataDetectionResults`, `richLinks`, `messageRichLinks`, `protectedMessageData`                                                              | Metadata, detected values, links and protected payloads.                                                   |
| `brandIndicators`, `brandIndicatorEvidence`, `addressMetadata`, `businesses`, `businessAddresses`, `businessCategories`, `senders`, `senderAddresses`, `events` | Sender and business metadata, S/MIME capabilities and detected events.                                     |
| `rules`, `ruleConditions`, `smartMailboxes`, `smartMailboxConditions`                                                                                           | Rules and smart mailboxes with their conditions.                                                           |
| `signatures`, `configuration`                                                                                                                                   | Signatures and the property lists of Mail.                                                                 |
| `messageFiles`                                                                                                                                                  | One row for each indexed message, with its `.emlx` file. This stream can give the file.                    |
| `messageHeaders`, `messageParts`                                                                                                                                | The headers of each MIME part, and the MIME tree with the decoded text of `text/*` parts.                  |
| `attachments`, `indexedAttachments`                                                                                                                             | Decoded attachments, and indexed attachments that are not downloaded yet. `attachments` can give the file. |

`messages.id` is the local row ID. `messages.messageId` is the hash of the RFC Message-ID. Integer IDs and hashes load as decimal strings.

All streams are snapshot streams. Use `incremental` with `append_dedup` and no `cursorField`. `messageFiles`, `messageHeaders`, `messageParts` and `attachments` keep one group for each message. A run reads a message again only if its files or index rows changed.

To store the files of `attachments` or `messageFiles` and read their text, declare a stored-file column and a `ComputedDataset` with the `DocumentText` rule, as the [Notes README](../notes/README.md) shows. See [attachment text](../../../../docs/reference.md#attachment-text).

## Access

Give **Full Disk Access** to the process that runs the pipeline. Mail needs it, and so does the system Accounts store (`~/Library/Accounts/Accounts4.sqlite`). Mail does not need Automation access.

- If the process cannot read the Mail store, or `PersistenceInfo.plist` or `Envelope Index` is missing, the read fails with `MailUnavailableError`.
- If the process cannot read the Accounts store, only `accounts` and `smtpServers` fail, with `AccountsUnavailableError`.
- If `Envelope Index` does not have a column that the reader uses, the read fails with `MissingColumnsError`. This error names each missing `table.column`.
- If Mail changes a file during a read, the stream fails with `MailChangingError`. The next run tries again.

## Scope

`new AppleMailSource({ path, accounts, scope })` narrows the import. `accountIds` selects accounts by the host of the mailbox URL, and `collectionIds` selects mailboxes by their ID. `startAt` (inclusive) and `endAt` (exclusive) select messages by their received date, or by their sent date if there is no received date. If you omit a key, the source reads all.

## Limitations

- The source reads only what Mail keeps on this Mac. An attachment that Mail did not download loads in `indexedAttachments`, without its file.
- Each run reads all selected records. Scan time and checkpoint size grow with the archive.
- A message that leaves the store or the scope is deleted from the destination.
- A watch sees only the local activity of Mail. To get remote changes, keep Mail open and syncing. If the Mail version directory changes, start the watch again.
- The source does not read passwords, authentication data, queues, search indexes or remote-content caches.

See [docs/reference.md](../../../../docs/reference.md#apple-mail) for the details.
