# @workspace/source-microsoft-teams

An ELT source for the data that the new Microsoft Teams app (`com.microsoft.teams2`) keeps on this Mac. It reads the app's own store with the `@workspace/sdk-microsoft-teams` SDK. It uses no Microsoft Graph, no token and no network. A Context Compiler import loads every stream into its `data.sqlite`, and readers query it through the `<snake_stream>` views.

The words in this README have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { TeamsSource } from '@workspace/source-microsoft-teams/teams-source';

// ~/Library/Containers/com.microsoft.teams2/…/EBWebView/WV2Profile_tfw
const source = new TeamsSource();
const destination = new SQLiteDestination({ path: './teams.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'teams',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({ path: './teams-state.sqlite' }),
      steps: [source.conversations, source.people, source.messages].map(
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

The app runs its web client in Edge WebView2. Work and school accounts share the WebView profile `WV2Profile_tfw` in the app's container. The client keeps its caches in the IndexedDB of `https://teams.microsoft.com`. It has one database for each manager of the client and for each signed-in account: `Teams:<manager>:react-web-client:<tenant>:<user>:<locale>`.

Most names put the tenant first. But the folder manager writes the user as `8:orgid:<user>`, and the search history writes the user first. Thus the SDK finds an account by the database of its conversation manager. Then it gives the account every database that names the same two IDs.

The same codecs as the [Slack desktop source](../../slack/desktop/README.md) read the bytes. `sdk-microsoft-teams` knows where the store is, which managers and object stores hold what, and what their records mean.

| Manager and object store                             | Streams                                                                                                                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation-manager/conversations`                 | `conversations`, `conversationMembers`, `pins`, and each conversation's newest messages                                                                                                 |
| `replychain-manager/replychains`                     | `messages` and their parts; the client's own feeds `48:calllogs`, `48:notifications`, `48:annotations`, `48:starred` give `callLogs`, `callParticipants`, `activities`, `savedMessages` |
| `streams-replychain-manager/saved`                   | `savedMessages` from `48:saved`                                                                                                                                                         |
| `syncstate-manager/syncstates`                       | which part of each conversation, channel thread and feed the client holds                                                                                                               |
| `activity-manager/feed-items`                        | whether the user has read an activity                                                                                                                                                   |
| `profiles/profiles`                                  | `people`                                                                                                                                                                                |
| `calendar/calendar`                                  | `meetings`, `meetingAttendees`                                                                                                                                                          |
| `conversation-folder-manager/folders`                | `folders`, `folderConversations`                                                                                                                                                        |
| `*-installed-apps-manager` entitlements, definitions | `installedApps`                                                                                                                                                                         |
| `search-history-manager/searchhistory`               | `searches`                                                                                                                                                                              |
| `tenant-manager/tenant`                              | the account's verified domains                                                                                                                                                          |

The other managers of the client hold Microsoft's own data or its bookkeeping: the app store's catalog of about 3,800 apps, the emoji catalog, policies, feature settings, telemetry and suggestions. The source reads none of them. The `MSTeams/lds` SQLite file next to the WebView profile is an old store of an older client. The Outlook storage buckets of the profile keep only sync logs.

## Access

The app's container needs Full Disk Access (see [Full Disk Access](../../apple/messages/README.md)).

- Without the grant, or without the app, the read fails with `TeamsUnavailableError`, which names the grant. Every stream fails.
- A record in a shape that the reader has not verified fails with `TeamsFormatError`, which names the database, the object store, the key and the field. Every stream fails, because one read makes all streams.

## Streams

| Stream                | One record per                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `accounts`            | work or school account signed in to the app, with its organization and verified domains           |
| `conversations`       | chat, meeting chat, team (its `Space`, the General channel) and channel, all of them              |
| `conversationMembers` | member of a chat, meeting chat or team whose member list the app keeps                            |
| `messages`            | chat and channel message the app has held, and the newest of every conversation                   |
| `messageReactions`    | person's reaction to a message, with when                                                         |
| `messageMentions`     | mention in a message: a person, everyone, a channel, team or tag                                  |
| `messageFiles`        | file attached to a message, metadata and its OneDrive or SharePoint addresses                     |
| `messageLinks`        | link in a message, with the preview Teams shows                                                   |
| `messageQuotes`       | earlier message a message replies to by quoting it                                                |
| `pins`                | message pinned to a conversation, in its order                                                    |
| `callLogs`            | call in the call history the app holds, its times to the ten-millionth of a second                |
| `callParticipants`    | participant of a group call                                                                       |
| `activities`          | entry of the activity feed, and of the reactions to the user's messages, with whether it was read |
| `savedMessages`       | message the user saved, or starred before Teams called it saving                                  |
| `people`              | person or bot the app has looked up in the directory                                              |
| `meetings`            | meeting on the calendar the app holds                                                             |
| `meetingAttendees`    | attendee of a meeting, with their answer                                                          |
| `folders`             | folder of the chat list                                                                           |
| `folderConversations` | conversation in a folder                                                                          |
| `installedApps`       | app installed for the user, or in a chat or team whose apps the app has loaded                    |
| `searches`            | search the user ran that the app kept                                                             |

Every key has `accountId`, the user's Entra object ID.

- **Message keys.** Teams names a message by the time at which the service received it, in milliseconds. Thus a message's key is its conversation, its thread and that ID. The thread is the message itself, except for a reply in a channel. `sentAt` is the same instant.
- **Content.** A message keeps its content as Teams holds it: HTML for rich text, and XML for calls and recordings. Adaptive cards stay JSON in `cardsJson`.
- **Deleted messages.** A deleted message keeps its place, with `content` null and `deletedAt`, as Teams keeps it.
- **Instants.** Instants that Teams writes as text keep their digits. A call's times keep 7 fraction digits. A meeting's change time moves from its offset to UTC.
- **Read state.** `lastReadAt` is when the user last read a conversation.
- **Files.** Teams can list one file several times in one message, each entry identical. `messageFiles` loads such a file one time.

## What the app holds, and deletions

The app keeps every conversation, because it syncs the chat list from the start of time. But it keeps only the messages that it loaded. On 2026-10-12, the cache of one account held 5,960 messages in 54 of 487 conversations, from 2021 to that day, and the newest message of 433 conversations. Older history gets to the import only when the app loads it while the import runs.

The client records in `syncstates` the span of each conversation that it holds: `chatServiceStartOfSyncWindow` to `chatServiceEndOfSyncWindow`, or from the start of time. When the client prunes its cache, it moves the start of the span. A channel loads only the latest replies of a thread with its posts. The client records a separate span for each channel thread that the user opens, with the key `<channel>;messageid=<thread>`.

The reads cover exactly those spans (see partly held upstreams in [elt](../../../elt/README.md) and [ADR 0001](./docs/adr/0001-a-message-is-deleted-only-inside-a-held-span.md)):

- A chat message or a channel post that is gone from inside the span of its conversation, ends included, was deleted. The source deletes it.
- Only the span of its thread covers a channel reply.
- A message outside all spans left the cache. It stays until a read covers it again.
- A span with a gap in it covers nothing.
- Reactions, mentions, files, links and quotes follow their message.
- Call logs, activities and saved messages are messages of the client's own feeds. They follow the spans of those feeds in the same way.

A record that disappears outside all spans is unknown. It stays in the snapshot, so a later read that covers its place judges it again. A reply that was deleted while the app did not hold its thread is deleted when the app loads the thread again. Slack's held ranges work in the same way.

Other deletions:

- A conversation that the app stops listing is deleted, with its pins. A folder that the app stops listing is deleted, and so is a conversation that the user took out of a folder.
- Members are deleted only from a conversation whose member list the app still keeps.
- Apps are deleted only from a user, chat or team whose apps the app still lists.
- An account whose databases are gone keeps all its rows. An example is an account that the user signed out of.
- The app keeps only the people that it looked up recently, the meetings of a span around today that it does not record, and its latest searches. Thus `people`, `meetings` and `searches` are forgetting streams (see forgetting upstreams in [elt](../../../elt/README.md)). A cancelled meeting shows it in `isCancelled`.

## Import scope

Accounts are accounts, and collections are conversations. A date range selects messages and their parts by `sentAt`. Pins, members and folder entries belong to their conversation, whatever the dates. People, meetings, call logs, activities, saved messages, apps and searches belong to an account, not to a conversation, and load fully.

## Watching

The web client writes its caches while it works.

- A watch polls the sizes and modification times of the files in the IndexedDB folder every second, through `TeamsStore.version()`.
- A write wakes every selected stream. The snapshot diff writes nothing for the streams that did not change.
- One read of the store took about one second for 39 MB on 2026-10-12.
- LevelDB compacts its files while the app runs. A read that loses a file to a compaction reads again, up to two more times.
- The store is current only as of the last write of the web client. The source gives the last modification time of the store's files as `currentAsOf`.

## Limitations

- Personal Microsoft accounts keep their client in a different WebView profile, for `teams.live.com`. The source does not read it (backlog #2612).
- When the app language of Teams changes, its web client starts a new set of databases for each account (`…:en-gb` next to `…:en-us`). It leaves the old set on disk, with what it had cached. The source reads only the database set that the client synced last, by the newest `lastSyncTime` among its sync states. Thus, after a change, the source follows the new cache. Rows that the import loaded before stay. But the first import after a change does not read history that only the old set holds. See [ADR 0002](./docs/adr/0002-the-source-reads-the-database-set-that-the-client-synced-last.md).
- Files stay in OneDrive or SharePoint. The app keeps no copy, so `messageFiles` holds their metadata and addresses only.
- A Viva Engage community keeps, as its newest message, a placeholder with no type, no sender and no content for a post that Engage holds. It is not a message.

## Live checks

Checked on 2026-10-12 against Microsoft Teams 26163.407 (Edge WebView2 149) on macOS 27.0, with one work account:

- The codecs decoded the full `teams.microsoft.com` IndexedDB, about 100 object stores, with no change to the codecs. The store held 487 conversations, 5,285 reply chains with 5,960 messages, 803 sync states, 129 profiles, 24 meetings from one week back to ten weeks ahead, 226 activity feed items, and 1,062 installed apps across the user, chats and teams.
- With the spans of channel threads, 8 of the 5,960 cached messages were outside all spans. A conversation with no cached message keeps an empty span (the start is after the end).
- A load through the Context Compiler CLI wrote all 21 streams, 19,823 rows in 3 seconds: 1 account, 487 conversations, 5,314 members, 5,713 messages, 3,611 reactions, 1,609 mentions, 82 files, 737 links, 225 quotes, 14 pins, 196 call logs, 167 call participants, 387 activities, 6 saved messages, 129 people, 24 meetings, 34 attendees, 7 folders, 17 folder entries, 1,062 apps and 1 search. A second load wrote and deleted nothing, so no value changes for each read. Of the messages, 5,354 have a sender that `people` holds.
- The probe changed the app language from English (United States) to English (United Kingdom) and restarted the app. This left 99 `en-us` databases (13,812 records) next to 99 new `en-gb` databases (5,890 records, and more each minute). The `en-gb` set synced at 13:40 UTC and the `en-us` set last at 12:37 UTC, and the read took the `en-gb` set. The probe then set the language to follow macOS again. The `en-us` set became the set synced last (14:14 UTC), and the read took it again. Teams' own `app_settings.json` then said `en-jo`, macOS's English (Jordan), while the client still wrote the `en-us` databases. Thus the setting does not name the set. The sync times do.
- The link preview of one message held raw line breaks inside its JSON text, which Teams writes with no other whitespace. The reader escapes them and reads the text. Four call logs were recording or transcript notices with no call log. They load as messages.
- In the user's own notes chat (`48:notes`), each change got to the next load:
  - A posted message loaded as a new message from the user.
  - A like loaded as a `messageReactions` row (`yes-tone2`, with its time). Removing the like deleted the row.
  - An edit loaded as the message written again, with `editedAt`.
  - A pin loaded as a `pins` row, and an unpin deleted the row.
  - Deleting the message loaded the same row with `deletedAt` and no content.
- The pin got to `threadProperties.pinnedItems` at once, while the conversation's own copy, `pinnedItems`, stayed empty. In every other conversation the two lists were the same. `pins` reads the thread's list.

## Decisions

- [ADR 0001: A message is deleted only inside a held span](./docs/adr/0001-a-message-is-deleted-only-inside-a-held-span.md)
- [ADR 0002: The source reads the database set that the client synced last](./docs/adr/0002-the-source-reads-the-database-set-that-the-client-synced-last.md)
