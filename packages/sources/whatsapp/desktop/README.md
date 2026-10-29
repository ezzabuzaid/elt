# @workspace/source-whatsapp-desktop

An ELT source for the data that WhatsApp for Mac keeps on this Mac. It reads the app's own stores with the `@workspace/sdk-whatsapp-desktop` SDK. It uses no WhatsApp server, no session and no network. A Context Compiler import loads every stream into its `data.sqlite`, and readers query it through the `<snake_stream>` views. `apps/proactive` loads chats, messages, reactions, users, contacts and push names into the warehouse as `marts.whatsapp_<stream>`.

The words in this README have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { WhatsAppDesktopSource } from '@workspace/source-whatsapp-desktop/whatsapp-desktop-source';

// ~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared
const source = new WhatsAppDesktopSource();
const destination = new SQLiteDestination({ path: './whatsapp.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'whatsapp',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './whatsapp-state.sqlite',
      }),
      steps: [source.chats, source.messages, source.users].map(
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

## How the stores are read

WhatsApp for Mac is WhatsApp's iOS app, built for the Mac. It keeps its data in the group container that it shares with its extensions, `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared`. The data is in SQLite stores that WhatsApp keeps open with a WAL. The SDK reads each store as of one moment, through `Snapshot` from `@zukhruf/sqlite-snapshot`.

| Store                              | Holds                                                                                  | Streams                                                                                                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChatStorage.sqlite`               | Core Data model `WhatsAppChat`: chats, messages with their media item and receipt info | `chats`, `messages`, `messageReceipts`, `messageReactions`, `messageReactionCounts`, `messageDataItems`, `groupMembers`, `groupMembersChanges`, `chatPushConfigs`, `pushNames`, `profilePictures`, `blockedContacts` |
| `ContactsV2.sqlite`                | The address book's people WhatsApp found on WhatsApp                                   | `contacts`                                                                                                                                                                                                           |
| `LID.sqlite`                       | WhatsApp users by LID, with the phone number they share                                | `users`                                                                                                                                                                                                              |
| `CallHistory.sqlite`               | Calls and the call-log entries that hold them                                          | `calls`, `callParticipants`                                                                                                                                                                                          |
| `ExtChatDB/ExtChatDatabase.sqlite` | Which message belongs to which, such as a photo to its album                           | `messageAssociations`                                                                                                                                                                                                |
| `Biz/Biz.sqlite`                   | Profiles of businesses the account chats with                                          | `businessProfiles`, `businessVerifiedNames`, `businessCategories`, `businessHours`, `businessServiceAreas`, `businessBotPrompts`                                                                                     |
| `statusDB/Status.sqlite`           | Contacts' statuses                                                                     | `statuses`                                                                                                                                                                                                           |
| `Sticker.sqlite`                   | Sticker packs and stickers                                                             | `stickerPacks`, `stickers`                                                                                                                                                                                           |
| `LocalKeyValue.sqlite`             | Settings and what WhatsApp learned of people on this Mac, among caches                 | `privacySettings`, `disappearingModes`, `linkedProfiles`, `changedNumbers`                                                                                                                                           |
| `BackedUpKeyValue.sqlite`          | What WhatsApp backs up with the account, among tokens                                  | `favoriteStickers`, `recentStickers`                                                                                                                                                                                 |

Media, profile picture thumbnails and stickers are files in the container:

- The file of a message or a status is under `Message/`, at its `mediaLocalPath` or `filePath`.
- A profile picture is at `<path>.thumb`.
- A sticker is under `stickers/`.

## Access

The group container needs Full Disk Access (see [Full Disk Access](../../apple/messages/README.md#full-disk-access)), or the consent of macOS to read the data of another app. Each store opens separately.

- A store that is missing, or that macOS refuses, fails with `WhatsAppUnavailableError`, which names the store and the grant. Only the streams that read that store fail.
- A store that is not an SQLite database fails its streams as a system failure.
- The SDK checks each column that a store's reader reads when the snapshot of that store opens. When a column is missing, the streams of that store fail with `MissingColumnsError`, which names each missing column. The other stores load.
- A value that the reader cannot decode fails the streams that decode it. An example is a receipt that names a recipient of a kind that the reader does not know.
- In all these cases, the source deletes nothing.

## Streams

| Stream                  | One record per                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `chats`                 | chat: a person, a group, a community's group, a channel, a broadcast list, a contact's statuses, with a group's details |
| `messages`              | message, with its media item: file, link preview, contact card or place                                                 |
| `messageReceipts`       | recipient a message's receipts name, with when it was delivered, read and played                                        |
| `messageReactions`      | reaction to a message, a withdrawn one with no emoji                                                                    |
| `messageReactionCounts` | emoji people reacted with to a channel post, with how many                                                              |
| `messageDataItems`      | link WhatsApp found in a message, with the page's title and description                                                 |
| `messageAssociations`   | message shown as part of another, such as an album's photo                                                              |
| `groupMembers`          | person WhatsApp lists for a group, including those who left                                                             |
| `groupMembersChanges`   | change to a group's members WhatsApp keeps                                                                              |
| `chatPushConfigs`       | chat with its own notification settings, such as a mute                                                                 |
| `pushNames`             | person whose own WhatsApp name the account has seen                                                                     |
| `profilePictures`       | person or group whose picture WhatsApp looked up, with the thumbnail it keeps                                           |
| `blockedContacts`       | person the account blocked                                                                                              |
| `contacts`              | address book phone number WhatsApp found on WhatsApp                                                                    |
| `users`                 | WhatsApp user by LID, with the phone number when they share it                                                          |
| `calls`                 | call, with the direction, missed state and video of the call-log entry holding it                                       |
| `callParticipants`      | other party on a call                                                                                                   |
| `businessProfiles`      | business profile, with its websites, Facebook page and Instagram account                                                |
| `businessVerifiedNames` | business with a verified name, by LID, with its business-platform role                                                  |
| `businessCategories`    | category a business profile lists, in order                                                                             |
| `businessHours`         | opening a business lists for a day of the week                                                                          |
| `businessServiceAreas`  | area a business says it serves                                                                                          |
| `businessBotPrompts`    | question a business's automated agent offers to start a chat with                                                       |
| `statuses`              | status a contact or the account posted, with its text styling or link preview and its photo or video                    |
| `stickerPacks`          | sticker pack in the picker's tray, and pack in the copy WhatsApp keeps of its store                                     |
| `stickers`              | sticker WhatsApp keeps: a tray pack's, or one the account favorited or sent                                             |
| `favoriteStickers`      | sticker the account favorited, with when                                                                                |
| `recentStickers`        | sticker in the picker's recent list, in its order                                                                       |
| `privacySettings`       | privacy setting of the account, such as who sees its last seen                                                          |
| `disappearingModes`     | account's default timer for messages in new chats, the account's own among them                                         |
| `linkedProfiles`        | account on another service a person links to their profile                                                              |
| `changedNumbers`        | person WhatsApp saw move to a new phone number                                                                          |

## Identities and values

WhatsApp names a person by a JID: `<number>@s.whatsapp.net` by phone number, or `<LID>@lid`. A LID is a number that WhatsApp gives in place of the phone number. WhatsApp is moving chats from the first form to the second, so one person can have both. `users` maps each LID to the phone number when the person shares it. `contacts` gives both for the people of the address book. A one-person chat keeps the person's other JID in `contactIdentifier`: a chat keyed by phone number holds the LID, and a chat keyed by LID holds the phone JID. `contacts.phoneNumber` keeps its `+`, and `users.phoneNumber` is digits only. Groups are `…@g.us`, and channels are `…@newsletter`.

A message has the key that WhatsApp gives it: its chat's JID, whether this account sent it, and the stanza ID that its sender gave it.

- WhatsApp keeps a second copy of a few messages (1 pair of 54,627 messages), and a second, empty session for a few chats (1 of 909). The first copy is used for both.
- A message whose chat WhatsApp removed belongs to no conversation that WhatsApp shows, and has no key. The source does not read it. One such message was found, a type 28 notice.
- `senderJid` is the group member who sent a group message, or the person for a message from one person. It is NULL for the account's own messages, and for notices and channel posts, which name no person.

Each record keeps WhatsApp's codes (chat and message kinds, statuses, flags) as numbers, because WhatsApp documents none of them. The stream descriptions name the values seen.

Dates:

- Core Data stores a date as seconds since 2001-01-01 in a double. It loads as a `date-time` with `precision` 6 (see the string formats in [elt](../../../elt/README.md#string-formats)).
- Foundation's distant past, which WhatsApp writes where it has no date, loads as `0000-12-30T00:00:00.000000Z`. A mute with no end loads as `4001-01-01`.
- Receipt times are whole seconds, and reaction times are milliseconds. Status times are whole seconds, kept to the millisecond.

A message's media item holds different things for different kinds of message, under the names that WhatsApp's model gives them:

- For a photo or a video, `vCardName` is the file's SHA-256 in base64, `vCardString` is its MIME type, `latitude` and `longitude` are its height and width in pixels, and `title` is its caption.
- For a contact card, they hold the name and the vCard of the card.
- For a place, they hold its coordinates.
- For a document, `authorName` is the file name.

WhatsApp writes two blobs as protobufs with no published schema. The SDK decodes them by the field numbers that the store shows, and keeps each blob as base64 next to the decoded fields:

- `metadata` (`ZWAMEDIAITEM.ZMETADATA`): field 5 is the quoted stanza ID of a reply. It named a message of the same chat for 9,948 of 10,018 replies. Field 6 is the sender of the quoted message. The blob also holds link previews, list menus and a 32-byte secret for each message, which the SDK does not decode.
- `receiptInfo` (`ZWAMESSAGEINFO.ZRECEIPTINFO`):
  - Field 3 is the time of the message in Unix seconds.
  - Each field 2 is a recipient. Its JID is packed in up to nine bytes: `0x81` and then the number in binary-coded decimal for `@s.whatsapp.net`, `0x8c` for `@lid`, and `0x83` for `@bot`.
  - Fields 4, 5 and 6 are the seconds after field 3 until delivery, reading and playing. A message with status 8 has field 5, and a voice note that was played (status 5) has field 6.
  - Field 7 holds reactions: a stanza ID (1), the sender (2, absent exactly when field 6 marks the account's own), the emoji (3, absent after the reaction is withdrawn) and the time in milliseconds (4). The counts for each emoji of a channel post are in field 7.3.
  - Recipients include the account's own other devices.

Business profiles archive their websites, hours and linked accounts with NSKeyedArchiver. Hours are `WABizHoursConfig` objects. Their `day` starts at 1, Sunday. Their `mode` is 0 for open all day, 1 for set hours, or 2 for by appointment, as the app's own code maps them. The serial of a verified name certificate is larger than 2^53 and loads as an `int64` (see the string formats in [elt](../../../elt/README.md#string-formats)).

Left out:

- The keys by which WhatsApp encrypts or downloads: media keys, the keys and encrypted hashes of stickers and statuses, a status's secret, the device lists of contacts, the Signal store `Axolotl.sqlite`, and `enc-key.dat`.
- WhatsApp's own bookkeeping: Spotlight and search-index states, encryption retries, participant hashes, sync tags, and Core Data row references.
- The caches, tokens, queues and telemetry of the key-value stores.

## What WhatsApp holds, and deletions

WhatsApp writes its chats and messages only while the app runs. Its notification extension decrypts pushes, but it does not write `ChatStorage.sqlite`. Thus a message gets to the import after WhatsApp ran since the message arrived. WhatsApp holds the history that it synced from the phone when the user linked it (here, back to 2020-07), and what it received since. But it downloads little media: 78 of 52,195 media items had their file on this Mac. Thus most messages load as metadata.

Each stream compares a full read of its store with the previous read:

- A record that did not change is not written. A changed record is written.
- A record that WhatsApp no longer holds is deleted, with the receipts and reactions of a deleted message.

Statuses expire by `timestamp` (see expiring upstreams in [elt](../../../elt/README.md#expiring-upstreams) and [ADR 0001](./docs/adr/0001-a-status-that-whatsapp-removes-after-a-day-stays-loaded.md)). WhatsApp keeps a contact's status for one day after it is posted. Then its sweep removes it (`SELECT … FROM status WHERE timestamp <= ? AND is_archived = 0`, then `DELETE … WHERE row_id = ?`), and the source sees no deletion. Thus a status that disappeared more than 23 hours after it was posted stays. A status that disappeared before then was withdrawn, and the source deletes it. The account's own statuses, whose sender is `status_me`, are archived (`is_archived` 1), not removed.

## Import scope

Collections are chats, by JID. Chats select their messages, group members, member changes and notification settings. A date range selects messages by `messageDate`. Receipts, reactions, reaction counts, data items and associations follow the messages that the import keeps. The other streams belong to no chat and load fully.

## Watching

- A watch polls the `data_version` of each store every second. `data_version` changes with each commit that WhatsApp makes. A change wakes only the streams of the store that changed.
- A store that WhatsApp makes while the watch runs reads as missing until it appears. When it appears, it wakes its streams.
- While WhatsApp runs, the source gives no `currentAsOf`: the stores are current when the source reads them. While WhatsApp is closed, each stream is current only as of the last write of its store.

## Limitations

- A status that the source did not load within its day is lost, with its file. To keep statuses, run a watch within that day.
- Per-chat disappearing timers were not found in any store. `disappearingModes` holds the default timer of each account, not of a chat.
- The source does not read these stores and tables. Each one held this on the test Mac:
  - `Labels.sqlite`: business labels and lists, empty.
  - `Location.sqlite`: live location, empty.
  - `ZWAZ1PAYMENTTRANSACTION`: payments, which WhatsApp offers in few countries, empty.
  - `ZWACHATPROPERTIES` and `ZWAVCARDMENTION`: empty.
  - Joinable and upcoming calls: empty.
  - The app-state sync log (`AppState`), the message queues (`MessagingInfraDB_v2`), the search indexes (`fts`, `channels-fts`), and the status counts for each sender (`status_info`).
  - The preferences in `Library/Preferences/group.net.whatsapp.WhatsApp.shared.plist`, for example whether read receipts are off (backlog #2604).

## Live checks

Checked on 2026-10-12 against WhatsApp for Mac 26.38.74 (model `WhatsAppChat_2.18.10`) on macOS 27.0, read-only:

- The container held 54,627 messages in 909 chats (772 with one person, 113 groups, 14 of session type 4, 5 status, 4 channels, 1 broadcast list), 8,424 group members, 4,792 LID users, 325 contacts, 190 calls, 171 business profiles, 15 statuses and 246 stickers. Every stream loaded in 1.6 s. The main stream of each store counted what the store holds (the live test for each store).
- Message kinds were read from the media items that they carry: kind 1 `image/jpeg`, 2 `video/mp4`, 3 `audio/ogg; codecs=opus`, 4 a vCard, 5 coordinates within 25–32° N, 7 a URL found in the text, 8 a file name with its extension (201 of 202), and 15 `image/webp`. For 5 photos on disk, `vCardName` was the same as the file's SHA-256, and `latitude` × `longitude` was its height × width. A photo's caption is its `title`: photos never have `ZTEXT`, and all 128 links that WhatsApp found in photo messages (`ZWAMESSAGEDATAITEM`) are in the photo's title.
- A live `sync watch` through the Context Compiler CLI woke only the streams of the store that WhatsApp committed to (12, 16 or 17 of 32), and wrote only what changed. A message sent to the account's own chat got to `ChatStorage.sqlite` at once. When the user deleted it in WhatsApp, its row disappeared, and the next pass deleted it and its receipt from the import.
- Edits and deletions were read from the copies that replies keep of what they quote. 59 replies quote a text that is different from the current text of their target, and not a shorter prefix of it. Thus an edit writes `ZTEXT` again in place, under the same key, and the import writes the message again. A message deleted for everyone stays as a type 14 row: all 350 such rows have their content removed, and in 36 group messages `ZTEXT` names the admin who deleted the message. No reply quotes a type 14 row.
- Receipts: of 13,638 messages that the account sent to one person, each message with status 8 had a read time, and each voice note with status 5 had a played time. 186,320 recipient JIDs unpacked, all with a known first byte, and 180,810 of them named a JID that the store holds in a different place.
- Reactions: in all 14,575, the sender was absent exactly when field 6 was 1, and was never the account's own JID or LID. Each sender held a maximum of one reaction for each message. None of the 91 reactions with no emoji was next to an emoji from the same sender. Thus WhatsApp keeps the latest reaction of each person, empty after the person withdraws it.
- Calls: `ZWACDCALLEVENTPARTICIPANT.Z1PARTICIPANTS` names the call-log entry (`WAAggregateCallEvent`, entity 1), not the call. The entry of a group call held its 3 and 4 participants, where a join on the row number of the call gave 1.
- The modes and days of business hours were mapped from WhatsApp's own code (`-[WABizHoursConfig modeServerStringValue]`, `dayServerStringValue`). Verified names keep 4 businesses with no profile.
- Statuses: 15 from 6 contacts, all within their day. Type 3 is a text post with styling, 4 a photo (`image/jpeg`), 5 a video (`video/mp4`), and 10 a link post whose text is its URL. The media item of a status is its only media item, with its file under `Message/` (5 of 11 downloaded, each with the same SHA-256 as its item).
- Statuses expired live: at 11:51 UTC, WhatsApp deleted the four statuses posted 24 hours before (15 rows to 11), with their media, thumbnails and files. It archived none of them. A sync just after that deleted nothing and kept all 14 statuses that it had loaded.
- The Context Compiler CLI, from a scratch working folder, loaded all 32 streams in 12 s, with 82 message files, 256 profile thumbnails, 173 stickers and 5 status photos. The next two syncs wrote and deleted nothing. The WhatsApp connection of `apps/proactive` loaded `marts.whatsapp_messages` (54,674 rows), and wrote nothing on its second pass.
- `disappearing-mode` holds the default timer of each account, not of a chat: 3,832 LIDs against 908 chats, with durations 0, 86,400, 604,800 and 7,776,000 only.

## Decisions

- [ADR 0001: A status that WhatsApp removes after a day stays loaded](./docs/adr/0001-a-status-that-whatsapp-removes-after-a-day-stays-loaded.md)
