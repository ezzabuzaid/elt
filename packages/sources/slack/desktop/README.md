# @workspace/source-slack-desktop

An ELT source for the data that the Slack desktop app keeps on this Mac. It reads the app's own store with the `@workspace/sdk-slack-desktop` SDK. It uses no Slack API, no token and no network. A Context Compiler import loads every stream into its `data.sqlite`, and readers query it through the `<snake_stream>` views.

The words in this README have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { SlackDesktopSource } from '@workspace/source-slack-desktop/slack-desktop-source';

// Finds the store of the Slack build on this Mac; new SlackDesktopSource(directory) chooses one.
const source = new SlackDesktopSource();
const destination = new SQLiteDestination({ path: './slack.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'slack',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({ path: './slack-state.sqlite' }),
      steps: [source.channels, source.members, source.messages].map(
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

## How the store is read

The Slack app is an Electron app. Its web client saves its Redux state in the IndexedDB of `https://app.slack.com`. The store keeps one client record for each signed-in workspace: `persist:slack-client-<workspace>-<user>`, in the object store `reduxPersistenceStore` of the database `reduxPersistence`. Four packages read the store. Each package owns one layer:

| Package                    | Reads                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codec-leveldb`            | LevelDB's files without opening the database: CURRENT and the MANIFEST's version edits name the live tables and logs; the write with the highest sequence wins      |
| `codec-v8-serialization`   | V8's ValueSerializer, formats 13 to 16, object references and all storable values                                                                                   |
| `codec-chromium-indexeddb` | Chromium's IndexedDB keys, database and object store names, Blink's value wrapping (a blob file `FF 11 01`, Snappy `FF 11 02`) and its envelope around V8's bytes   |
| `sdk-slack-desktop`        | Where the app keeps its store, which records are clients, what each slice means, the app's own state in `storage/root-state.json`, its errors and its change signal |

Slack 4.52.171 runs Electron 44 (Chromium 152, V8 15.2). Its V8 writes format 16. The `v8.Deserializer` of Node 26 refuses format 16, and format 16 changed only how V8 writes the sizes of buffers and views. Chromium keeps IndexedDB in LevelDB for apps on disk. Chromium main has a move to SQLite behind flags, off by default on 2026-10-08.

## Where the store is

Slack has two builds for macOS. Both builds keep the same store in Electron's user data folder:

- The build from slack.com keeps it in `~/Library/Application Support/Slack`.
- The Mac App Store build keeps it in `~/Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack`.

A folder has a store when its IndexedDB folder has a `CURRENT` file.

Each `SlackDesktopSource` finds its folder one time, when you make it (`slackDesktopDirectory()` of the SDK):

- When both folders have a store, the source uses the store whose files changed last. This occurs, for example, when the user changed builds and the old build left its folder.
- When no folder has a store, the source uses the folder that gave an access error. Thus the read reports the missing grant.
- When no folder gave an error, the source uses the slack.com folder.

To choose a folder, give it to the constructor: `new SlackDesktopSource(directory)`.

## Access

The Mac App Store build's container needs Full Disk Access (see [Full Disk Access](../../apple/messages/README.md)), or the consent of macOS to read the data of another app.

- Without the grant, or without the app, the read fails with `SlackDesktopUnavailableError`, which names the grant. Every stream fails.
- Bytes in a format that the reader does not know fail with `SlackDesktopFormatError`, which names the record and the field. Examples are a V8 format above 16, a log record whose checksum fails, and a slice of a different shape.
- In both cases, the source deletes nothing.

The app's own state, `storage/root-state.json`, is a separate file. Only `downloads` reads it:

- A `root-state.json` that is not JSON, or whose downloads have a different shape, fails only `downloads`.
- A damaged IndexedDB fails every stream other than `downloads`.
- A missing `root-state.json` means that there are no downloads.

## Streams

| Stream                   | One record per                                                              |
| ------------------------ | --------------------------------------------------------------------------- |
| `workspaces`             | workspace the app is signed in to and has saved, with the user signed in as |
| `channels`               | conversation the app knows: public and private channels, DMs, group DMs     |
| `channelMembers`         | member of a conversation whose members the app keeps (group DMs)            |
| `members`                | person, bot or app user the app knows in a workspace                        |
| `bots`                   | bot the app knows, such as an integration's sender                          |
| `apps`                   | Slack app the client has loaded                                             |
| `messages`               | channel message the app has held, without thread replies                    |
| `threadReplies`          | thread reply the app has held, never deleted                                |
| `messageAttachments`     | link preview, shared message or integration card under a message            |
| `messageReactions`       | emoji reaction on a message, with who reacted as far as the app knows       |
| `messageFiles`           | file a held message shares, in its order                                    |
| `pins`                   | message pinned in a conversation, with who pinned it and when               |
| `files`                  | file the app has held (upload, snippet, canvas, List), metadata only        |
| `fileShares`             | conversation and message a file was shared in, held or not                  |
| `listRecords`            | row of a Slack List the app opened, its cells as JSON                       |
| `channelSections`        | section of the user's sidebar                                               |
| `channelSectionChannels` | conversation the user put in a section                                      |
| `threadSubscriptions`    | thread the app knows whether the user follows                               |
| `preferences`            | user or workspace preference, its value as JSON                             |
| `userGroupMemberships`   | user group the app checked the signed-in user's membership of               |
| `downloads`              | file the app downloaded, with its bytes while the file is still there       |

Every key has `workspaceId`.

- **Messages.** A message's `ts` is Slack's own ID: seconds and microseconds, as Slack writes them. `sentAt` is the same instant, as a `date-time` with `precision` 6 (see the string formats in [elt](../../../elt/README.md)). `blocks`, attachment `fields` and preference values stay JSON, as Slack holds them.
- **Saved messages.** A message that the user saved for later has `savedState` (for example `in_progress`), `savedTodoState` (for example `saved`) and `isSavedArchived`. They come from the `saved` object that the app keeps on the message. The app keeps no list of saved items (`saved.list` and `saved.itemMap` stay empty). Thus the source does not know a saved message that the app does not hold.
- **Snippets.** A snippet's `content` is its full text.
- **Pins.** A pin's `pinnedBy` and `pinnedAt` come from the conversation's `pinned_items`. The app keeps them with each pinned message when it loads the pin list. Else they come from the pinned message's own `pinned_info`. Both are seconds. Both are NULL when the app holds neither. They are only in `pins`, not in `messages`, so the two streams cannot disagree.
- **Downloads.** `downloads` reads the app's own state, `storage/root-state.json`, not the IndexedDB: `downloads[<workspace>][<file>]`, with `downloadState`, `progress`, `startTime` and `endTime` in milliseconds, and `downloadPath`. `downloadPath` is the file in the Downloads folder of the build, unless the user saved it in a different folder. For the Mac App Store build, the Downloads folder is `~/Library/Containers/com.tinyspeck.slackmacgap/Data/Downloads`. With file reads, a download has its file while the file is still at that path. A download whose file moved or was deleted has no file.
- **Not records.** An object that the client marks `isNonExistent` is the client's note that a message or a member is gone. It is not a record.
- **Left out.** The client's UI state (`view`, `modal`, `searchUi` and the like) and `sundryStorage`, which holds only a cache watermark.

## What the app holds, and deletions

The app keeps every conversation, member and app that it knows, but only the messages that it loaded. On 2026-10-08, January held 31 messages in 3 of 13 conversations, and Delivery Associates held 28 messages in 1 of 24. Older history gets to the import only when the app loads it while the import runs. A free workspace hides messages older than 90 days (`isBeyondPlanLimit`).

The client records which ranges of each conversation it holds: `channelHistory[channel].slices[{ start, end, timestamps }]`. The reads cover exactly those held ranges (see partly held upstreams in [elt](../../../elt/README.md) and [ADR 0001](./docs/adr/0001-a-message-is-deleted-only-inside-a-held-range.md)):

- A message that is gone from inside a held range, ends included, was deleted. A message that the client marks `isNonExistent` was deleted. The source deletes both.
- A message outside all held ranges left the cache. It stays until a read covers its range again. That read deletes it if the app no longer holds it.
- Reactions and attachments follow their message. `messageFiles` follows its message.
- A workspace whose record the store no longer holds keeps all its rows. An example is a workspace that the user signed out of. Every other stream deletes what the app stops listing for a workspace that the store still holds.

Some streams delete nothing, or delete only in part:

- **Thread replies.** The client loads a thread's replies when the user opens the thread. It marks them `_hidden_reply` and records no range for them. Thus `threadReplies` is a forgetting stream (see forgetting upstreams in [elt](../../../elt/README.md)): a reply stays after the app drops it, also when the reply was deleted. The client does not load the reactions and attachments of replies.
- **Pins.** The client keeps `pins.pinsByChannel[channel]`, the pinned messages, and `pins.loadingStateByChannel[channel]`. The loading state is `loaded` when the client has loaded the full pin list of that conversation. A pin that is gone from a loaded list is deleted. After the last unpin, the list stays as `[]`. The pins of a conversation whose list is `loading`, or was never loaded, stay.
- **User group memberships.** These are the client's checks of whether the signed-in user is in a group. They are not a list of groups. Thus `userGroupMemberships` deletes nothing.
- **Downloads.** Downloads stay after the user clears Slack's list of downloads. `downloads` deletes nothing.
- **Files and Lists.** The app also caches the files and the List rows that it loaded. `files`, `fileShares` and `listRecords` keep what they saw. While the app still holds a deleted file or row, the deletion shows as `isDeleted`, `isTombstoned` or `isArchived`.

The app keeps no file contents. Its HTTP cache held no `files.slack.com` response, and `urlPrivate` needs Slack's sign-in. Thus `files` holds metadata only.

## Import scope

Accounts are workspaces, and collections are conversations. A date range selects messages, their attachments and their reactions by `sentAt`. Pins belong to their conversation, whatever the dates. Members, bots, apps, sections, preferences, user group memberships and downloads belong to a workspace, not to a conversation, and load fully.

## Watching

The app saves the full record of a workspace into a new blob file every few minutes while it runs, and when it quits. The record of a workspace first appears when its client unloads.

- A watch polls the sizes and modification times of the files in the IndexedDB folder, and of `storage/root-state.json`, every second, through `SlackDesktopStore.version()`. Thus a new download also wakes it.
- A save wakes every selected stream. The snapshot diff writes nothing for the streams that did not change.
- The app replaces and deletes the blob that a read reads. A read that loses that race reads again, up to two more times.
- The store is current only as of the last save. The source gives the last modification time of the store's files as `currentAsOf`.

## Limitations

- The source does not read calendar events. No calendar is connected to Slack in the test workspaces, and only the account owner can consent to connect one (backlog #2487).
- Slack's client also declares pins of type `file` and `file_comment`, which have no `ts`. No such pin was seen. Such a pin fails the read with `SlackDesktopFormatError`, which names the field.
- A user group's name and members are not on this Mac. See the live checks.

## Live checks

Checked on 2026-10-08 against Slack 4.52.171 on macOS 27.0:

- The store held one record per workspace: January's (514 KB serialized, 138 slices) and, after Delivery Associates' client unloaded on quit, Delivery Associates' beside it. Each save wrote the record to a new blob number (`…/01/166`, then `16f`, `172`, `178`), of the same size when nothing changed.
- The full store decoded in 86 ms. `codec-leveldb` found the same 55 live records as an independent reader, and `codec-v8-serialization` gave the same values as Node's own deserializer for every storable tag.
- A load through the Context Compiler CLI, narrowed to January, wrote 1 workspace, 13 conversations, 9 members, 2 bots, 5 apps, 31 messages, 9 attachments, 8 sections, 2 thread subscriptions and 1,075 preferences. A second load wrote nothing. Two reads with no save between them gave identical records, so no value changes for each read.
- Delivery Associates' record held 22 reactions, 3 edited messages, and private channels and group DMs with their members.

Checked on 2026-10-09:

- The app saved a direct message that it held no message of as one slice with no `start` and no `end` (`{ timestamps: [] }`). Such a slice holds nothing, so it covers no message of the conversation. Before the reader read that shape, it failed every stream of the import.
- A load through the Context Compiler CLI, narrowed to January, wrote 1 workspace, 13 conversations, 9 members, 88 messages, 27 attachments, 3 files and 1,076 preferences across its 21 streams. The probe had removed its pins, saved messages, snippets, memberships and downloads before the load. A second load wrote and deleted nothing.
- The client also records `reachedStart` and `reachedEnd` for each conversation: whether its held history gets to the first and the newest message of the conversation. The reads do not use them. The probe deleted the newest held message of a January conversation. The slice's `end` stayed at the ts of the deleted message, and `reachedEnd` stayed true. The message became the client's note that it no longer exists: `{ channel, ts, id, isNonExistent: true, __meta__ }`. The read covers that ts, so the source deletes the message.
- January's record showed each shape that the newer streams read. The probe made each one in the app:
  - A pinned message in `pins.pinsByChannel` (`{ type: "message", channel, ts }`), with its conversation `loaded`.
  - The same pin in the conversation's `pinned_items` (`created` in seconds, `created_by`, and the message), and on the message (`pinned_to`, `pinned_info: { pinned_by, pinned_ts }`). After the unpin, the conversation's list stayed as `[]`.
  - A message saved for later, with `saved: { is_archived, state: "in_progress", todo_state: "saved" }`.
  - A snippet whose file has `content`, mode `snippet`, filetype `text` and mimetype `text/plain`.
  - In `root-state.json`, a completed download: `downloadState` `completed`, `progress` 1, `startTime` and `endTime` in milliseconds, and `downloadPath` in the app's Downloads folder.
- After the user opened the People › User groups page, Delivery Associates' record held `userGroupMembership: { <group>: { isMember } }` (1 group, a member), but not the group: `userGroups` stayed `{}`, and `adminUserGroups` stayed empty. January is on the free plan, which cannot manage user groups (`featureAccess.user_groups__manage` is `{ is_enabled: false, reason: "restricted_plan_level" }`).
- Files, Lists and thread replies were checked against the record of Delivery Associates that was already on disk. The check read types and counts only: 13 files (a List, hosted files and snippets) with 2 shares, 10 messages that share files by ID, 2 List rows whose cells are under column IDs that the List file's `list_metadata.schema` names, and 1 reply in the shape of a channel message, with `_hidden_reply`.

Not verified on real data yet:

- Calendar events. See the limitations.
- The store of the Slack build from slack.com. The test Mac has only the Mac App Store build (backlog #2479).
- How the store compacts. The live database wrote no table while the probe watched it. Tests cover tables that LevelDB writes.

## Decisions

- [ADR 0001: A message is deleted only inside a held range](./docs/adr/0001-a-message-is-deleted-only-inside-a-held-range.md)
