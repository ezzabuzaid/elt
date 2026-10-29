# @workspace/source-apple-mail

An ELT source for Apple Mail. It reads the Mail store under `~/Library/Mail` through `@workspace/sdk-apple-mail`: the index (`Envelope Index`), the message files (`.emlx`), the detached files and the property lists. It reads the account and server settings from the system Accounts store through `@workspace/sdk-apple-accounts`. It does not write, it does not start Mail, and it does not use the network.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md). The decisions are in [docs/adr](./docs/adr).

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

The source finds the current version folder from `PersistenceInfo.plist`. Each run reads the index in one read-only transaction. To read a copy of the stores, give another `path` or another Accounts store path. The identity of the source is `apple-mail`. It names no folder, so a Mail store that you copy to another Mac keeps its checkpoints. The native keys of the index already include all accounts. `discover()` does no I/O.

## Streams

The source has 42 streams. Each stream is a property of the source, and `discover()` returns all of them.

| Streams                                                                                                                                                         | Data                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`, `smtpServers`                                                                                                                                       | The account and server settings from the system Accounts store as JSON, without secrets. A mailbox host that the store does not know, such as On My Mac, keeps the values that its URL gives. |
| `mailboxes`, `mailboxProperties`                                                                                                                                | The mailbox URLs, counts and native IDs of the index, and the properties in `.mbox/Info.plist`.                                                                                               |
| `messages`, `subjects`, `summaries`, `generatedSummaries`                                                                                                       | All message columns of the index, the subject and summary dictionaries, and the generated summary payloads.                                                                                   |
| `addresses`, `recipients`                                                                                                                                       | The address and comment dictionary, and the recipients of each message with their positions. Native rows without a parent also load.                                                          |
| `messageMailboxes`, `serverMessages`, `serverMessageMailboxes`                                                                                                  | Local and server mailbox memberships, message state and IMAP identifiers.                                                                                                                     |
| `conversations`, `conversationMessages`, `messageReferences`, `messageGlobalData`                                                                               | Conversation membership, reply references, global message status and deferred-action metadata.                                                                                                |
| `messageMetadata`, `dataDetectionResults`, `richLinks`, `messageRichLinks`, `protectedMessageData`                                                              | Native JSON, detected values, links and opaque protected payloads.                                                                                                                            |
| `brandIndicators`, `brandIndicatorEvidence`, `addressMetadata`, `businesses`, `businessAddresses`, `businessCategories`, `senders`, `senderAddresses`, `events` | Brand and certificate blobs, sender classification, business metadata, S/MIME capabilities and the metadata of detected events.                                                               |
| `rules`, `ruleConditions`                                                                                                                                       | Synced and local rules, their active flags, their conditions in order, and the original property dictionaries.                                                                                |
| `smartMailboxes`, `smartMailboxConditions`                                                                                                                      | The saved hierarchy, the criteria in order, and the original property dictionaries.                                                                                                           |
| `signatures`, `configuration`                                                                                                                                   | The MIME content of each signature, and the property lists of `MailData` and the signatures.                                                                                                  |
| `messageFiles`                                                                                                                                                  | One row for each indexed message: the relative path, local availability, the partial flag, the size, the SHA-256 and the original message file. This stream can give the file.                |
| `messageHeaders`                                                                                                                                                | The headers of each MIME part, in order: the unfolded and decoded value, and the original header line in base64.                                                                              |
| `messageParts`                                                                                                                                                  | The MIME tree: media type, charset, disposition, file name, content ID, local availability, size, SHA-256, and the decoded text of `text/*` parts.                                            |
| `attachments`, `indexedAttachments`                                                                                                                             | Decoded MIME attachments, and the attachments that the index lists before their MIME arrives. `attachments` can give the file. The native rows of the attachment index load separately.       |

To store the files of `attachments` or `messageFiles` and read their text, declare a stored-file column and a `ComputedDataset` with the `DocumentText` rule, as the [Notes README](../notes/README.md) shows. See [attachment text](../../../elt/README.md#attachment-text).

## Records

- The column names of the index become camel case. `ROWID` becomes `id`.
- Integer IDs and hashes load as decimal strings, so 64-bit values stay exact.
- `messages.id` is the local row ID. `attachments.messageId`, `messageParts.messageId` and `messageFiles.messageId` use it.
- `messages.messageId` is a different value: the hash of the RFC Message-ID. `messageGlobalData.messageId`, `conversationMessages.messageId` and `messageReferences.reference` use that hash.
- The host of a mailbox URL identifies the account folder.
- A message can be in more than one mailbox. Use the membership streams. Do not think that each message has one folder.
- A confirmed Unix timestamp becomes a UTC ISO string. A native date field whose unit is not confirmed keeps its number, with the suffix `Raw` on its name. A null stays null.
- A blob column becomes a base64 string. The source keeps configuration and opaque native payloads as they are. It does not guess a meaning that Apple does not document.
- The source does not read passwords, authentication data, transient queues, derived search indexes or remote-content caches.

## MIME and files

The source reads MIME with the public `Splitter` and `MimeNode.getDecoder()` APIs of `@zone-eu/mailsplit`, and it decodes encoded header words with `libmime`. The code for Apple reads only the byte frame of the message file and finds the detached files.

- An attached `message/rfc822` stays one complete decoded file.
- The root of a multipart message is `TEXT`. Its children have dotted MIME part numbers. A single-part message is `1`, as Apple's index numbers it before the file arrives. Thus the key of an attachment stays the same after a later download.
- Full MIME, inline images, calendar invitations, archives, binary files and attached messages all keep their bytes, also when no parser can read their text. The shared document parser returns null when it cannot extract text.
- Each file stays readable while the consumer uses it. The decoded attachments go into storage for the run, and the source releases each message after the consumer reads it. Body text decodes directly into its record, with no temporary file. A read of the headers does not decode the bodies.
- Each MIME stream reads the files of the run again. The temporary content holds one message, not the archive.
- The source checks the version of each message file before and after it reads the file. If Mail replaces or removes a file during a scan, the stream fails. It does not commit a wrong snapshot.
- A file that is missing at the start loads as not available.
- A message file that the index does not list is not a message. The source does not read it.

## Changes and deletions

All streams are snapshot streams. Use `incremental` with `append_dedup`, the full primary key of the stream, and no `cursorField`. Each run scans all selected records and lists each selected message.

`messageFiles`, `messageHeaders`, `messageParts` and `attachments` are grouped snapshots, with one message group for each message. The fingerprint of a group includes:

- the parser version (`messageParserVersion` in the source),
- the path of the message file, relative to the version folder, and its size and modification time in nanoseconds,
- the same values for each detached file of the message,
- the rows of the message in the `attachments` table of the index (attachment ID and name).

A message whose fingerprint did not change keeps its saved rows, and the run does not read it. Thus a run parses only new and changed messages. The selection runs on each pass: a message that leaves the scope has no group, and its rows are deleted. When parsing or the records of these streams change, increase `messageParserVersion`, and each message is read again.

- No date, message-count or file-size window applies.
- A change to flags, membership, bytes or availability updates the rows. A key that is gone gives a delete. A snapshot with no changes writes zero rows.
- The scan time and the checkpoint size increase with the archive. The temporary MIME disk space increases with the largest message. The destination staging and the stored original bytes need more disk space.
- The index is consistent in its transaction, but the files and settings of Mail are separate from it. A change during a run can fail a stream. Then run again.

## Watching

A watch keeps one recursive file watch on the Mail store, and it checks the `PRAGMA data_version` of the index each second. A commit or a file change refreshes the selected streams. A file change includes an attachment download that does not change the index. When the watch stops, it closes the file watch and the database handle.

A watch sees only the local activity of Mail. To get remote changes, keep Mail open and syncing. The account and server settings come from the system Accounts store, so Mail does not have to run for them. While `accounts` or `smtpServers` is selected, the watch also checks the `data_version` of that store each second. A commit there refreshes only those two streams. A Mail change also refreshes them, because it can add a mailbox host. If the process cannot open the Accounts store, the watch does not watch it, and each run reports the failure of those two streams. If the version folder of Mail changes, start the watch again.

`currentAsOf` is always the last write of the index of Mail, because the daemon of Mail writes it also while Mail.app is closed. See [how current a stream is](../../../elt/README.md#how-current-a-stream-is).

## Access and failures

Give **Full Disk Access** to the process that runs the pipeline. Mail's store needs it, and so does the system Accounts store (`~/Library/Accounts/Accounts4.sqlite`). Mail does not need Automation access.

- If the process cannot read the Mail store, or `PersistenceInfo.plist` or `Envelope Index` is missing, a read and a watch fail with `MailUnavailableError`.
- If `PersistenceInfo.plist` does not parse, or the index is not a database, the read fails with that error.
- If the process cannot read the Accounts store, only `accounts` and `smtpServers` fail, with `AccountsUnavailableError`.
- If `Envelope Index` does not have a column that the source reads, for example after a Mail release changes the layout, the read fails with `MissingColumnsError`, and no stream of that read loads. The error names each missing `table.column`: `The database at "<path>" lacks the columns …: its owner changed its layout. Update the reader to the new layout.`
- If Mail changes a file during a read, the stream fails with `MailChangingError`. The next run tries again.

Each error keeps its cause. The pipeline reports failures for each stream, and it keeps the data and the checkpoint of the last commit.

## Scope

`new AppleMailSource({ path, accounts, scope })` narrows the import. `accountIds` selects accounts by the host of the mailbox URL, and `collectionIds` selects mailboxes by their ID. `startAt` (inclusive) and `endAt` (exclusive) select messages by their received date, or by their sent date if there is no received date. If you omit a key, the source reads all.

A scoped import loads no record in the streams that no proven account or message owns: `messageMetadata`, `dataDetectionResults`, `protectedMessageData`, `smtpServers`, `mailboxProperties`, `configuration`, `rules`, `ruleConditions`, `smartMailboxes`, `smartMailboxConditions` and `signatures`. The source exports this list as `restrictedMailStreams`.

## Limitations

- The source reads only what Mail keeps on this Mac. An attachment that Mail did not download loads in `indexedAttachments`, without its file. Only Mail downloads remote content.
- Each run reads all selected records. The scan time and the checkpoint size increase with the archive.
- A message that leaves the store or the scope is deleted from the destination.
- A watch sees only the local activity of Mail. If the version folder changes, start the watch again.
- A rewrite of a message file with the same size and the same modification time in nanoseconds is not seen between passes.

## Live checks

### Store probe, 2026-09-26

On macOS 26.6.2 (Mail V10), the probe examined the full local archive. The first inventory had 25,253 message files (8,533 full and 16,720 partial), 536 detached files, three indexed messages without a local file, and sixteen message files that the index did not list. The probe examined membership in more than one mailbox, 64-bit hashes, the account identities of IMAP and iCloud, rule flags, nested smart mailboxes, and the units of the native timestamps.

### Access methods

The review selected the read-only index, the message files and the property lists for the local history, and the system Accounts store for the account and server settings. The reasons:

- Mail's scripting dictionary needs Automation access, and it can start Mail. Its `authentication` property fails for iCloud.
- A comparison on 2026-10-05 (macOS 27; Exchange, iCloud and Google accounts) matched each scripted account and SMTP field, except the server, port and SSL of an Exchange account. Scripting gives none, 0 and false for them. The Accounts store keeps no port for that account, and its EWS URL gives the host and HTTPS.
- iCloud keeps its TLS setting on the parent account. `SSLIsDirect` on the child tells only whether TLS starts when the connection starts or through STARTTLS.
- A manual mailbox export loses the relations of the index, and it gives no change signals.
- IMAP and provider APIs tell about remote accounts, not about the local folders or the downloaded state of this Mac.
- MailKit needs an installed extension. It gives delivery callbacks, not a reader for the history.
- A read of each message through scripting crosses the process boundary for the full archive.
- No public native framework gives all Mail history.
- File system notifications and SQLite commit detection together see downloads that change only files, and metadata edits. Polling scripting objects crosses process boundaries again and again.

### Checks, 2026-09-26

The checks used Node.js 26.8.1 and macOS 26.6.2. At that time, the Mail source was part of the `apple` project.

- `npx nx run apple:typecheck` and `npx nx run elt-sqlite:typecheck` passed. `apple:test` passed all 60 tests, and `elt-sqlite:test` passed all 31. Before the change, `apple` had 56 tests.
- Four Mail integration tests import `AppleMailSource` directly, and they load through a real pipeline and a real SQLite destination. They cover all 42 streams, exact file bytes, nested MIME, repeated, empty and encoded headers, 64-bit IDs, missing and later downloaded content, changed flags and memberships, deletion, unchanged runs, schema and read failures, kept checkpoints, file and index watch notifications, and cancellation. The fixtures hold only synthetic data and Apple's schema, never personal records.
- Native ImageIO and Vision checks sent 1-, 2- and 3-pixel images through the attachment pipeline. The smaller tracking pixels give null text and keep their original bytes. The PDF, text, image and HEIC checks (also a HEIC without an extension) pass. Backlog defect #2038 is closed.
- A full live copy of the attachments without a text parser loaded 1,152 records: 576 local files (122,303,823 bytes in 583 SQLite chunks) and 576 records not available. The second run, with no changes, wrote zero records and zero deletions.
- A Mail run through the Apple exporter completed 40 of 42 streams. It loaded 25,689 messages, 819,179 headers and 69,324 MIME parts, of which 46,251 were text parts (1,133,028,667 UTF-8 bytes). On 2026-09-27, all 25,689 stored original message files (1,379,197,940 bytes) were put together again and checked against the SHA-256 and the size of their source. Forty checkpoints committed. The full body snapshot passed after SQLite was changed to sort only row IDs. Before, sorting the full payloads used all temporary disk space on this Mac, whose disk was almost full.
- The next run through the entry point completed 39 streams. 38 wrote nothing (also messages, message files and headers), and two mailbox property rows updated. Mail changed message files during the later body and attachment scans, so those streams failed and kept their saved checkpoints. Native reads of all 33 mailbox property lists, done again and again, gave stable values and key order and matched the saved export. Thus the two updates were not differences of serialization.
- A temporary native mbox import appeared through `Pipeline.watch()`, and its read and flag changes reached SQLite. The check of deletion and of signature persistence did not complete: Mail's delete AppleEvent failed with `-10000`, a later message deletion stopped Mail with `-609`, and the locked Mac blocked the UI cleanup. The scripting API removed the temporary signature, and its native count was zero. The one-message local mailbox `Import/ContextCompiler-Mail-Probe-20260926` stayed for removal in the UI after the Mac was unlocked. No message was sent.
- The full `configuration` stream finds a `MailData/recentSearches.plist` that it may not read (`EPERM`; native `plutil` also gets it). A `SyncedFilesInfo.plist` that changes can fail the stream sooner.
- The default copy of attachment text finds a damaged local PDF at message `5597`, part `4`. The detached file starts inside document metadata, not with a PDF header, and PDFKit refuses it. These errors stay as they are. The byte-only copy above shows that the attachment extraction works without text parsing. Backlog #3214 records a stored PDF of a later sync that PDFKit also refuses.

### Implementation review, 2026-09-26

The `remove-code` review kept the Apple-specific frame, the detached-file lookup, the schema check and the file-change checks, because no adopted API does these jobs. It adopted the public `Splitter`, `MimeNode.getDecoder()`, `Headers.getList()` and `getFirst()`, `libmime.decodeHeader()` and `decodeWords()`, Node streams, `TextDecoder` and disposable stacks, native `plutil`, and the existing plist decoder, snapshot diff and pipeline. Searches of the package exports, types, runtime and debug hooks found no built-in EMLX reader and no hook to observe the archive. The measured call sites: one source caller each for `readMailMime` and `MailStore.open`, one destination factory for `SQLiteDeduplicatingWriter`, and four parser constructors in the exporter and the public integration tests.

- **Removed:** the archive-wide MIME cache and body staging. A read of each message with native stream decoding replaced them, and the exact-byte, body, unchanged-run and error tests pass. Disposable stacks own the resources. A cleanup catch in a constructor that had no use and a duplicate text-decoder setup were removed. SQLite ranks the staged row IDs, not the full payloads, and it gets the winning rows by primary key. Its tests of equivalence with sequential operations pass. A native transaction-rollback test shows that the original error and the rows of earlier commits stay.
- **Net change:** 2,515 lines added and 39 deleted (+2,476). This includes the five new source, platform and test files, dependency manifests, exports, documentation, the default exporter registration and the small SQLite correction. It adds code because it adds the 42-stream source and its synthetic integration tests on a native store. The counts do not include the earlier engine and destination work and the earlier skill move. The temporary probe scripts and package extracts were removed.
- **Kept:** the source and platform readers, the declared native table schema, the public integration tests, the docs and the dependency declarations. No separate cache, scheduler, migration or compatibility path stays.
- **Rejected:** the high-level `mailparser` hides the stable MIME part paths. The `Streamer` of mailsplit can change flowed text, so it cannot keep the original attachment bytes. `Headers.getDecoded()` drops empty values and does not decode encoded words; the ordered public header list with `libmime` keeps both. AppleScript for each message and MailKit do not give the local history in bulk.
- **Self-audit:** no compatibility branch, suppression directive, guessed native date epoch or catch that returns empty stays. The MIME values that can be null match `mime-node.js` lines 150–163 (`false` for a parsed value that is not available) and `headers.js` lines 90–100 (an empty string for a header that is not there). Mailsplit owns the inference of a missing Content-Type (lines 122–143), and `TextDecoder` owns its default charset. Missing downloaded files and property lists are states of the upstream, and failed reads throw. The account cache starts as null only so that one run makes one native call. The source path is explicit.

### Not verified

- Live deletion, signature persistence and a fully successful default run: the native Mail failures, the access failure and the damaged file above blocked them.
- A quiet full-body run again: Mail changed files during the repeated scan. The earlier full body export passed, and the earlier checkpoint stayed after the failure.
- The synthetic tests cover the contracts of these streams. They do not prove the blocked native behavior. No open backlog item replaces these checks.
