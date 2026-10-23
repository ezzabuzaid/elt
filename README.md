# elt

**Extract data from native apps. Load it into SQLite or Postgres. Keep it up to date.**

`elt` is a TypeScript library for declaring and running ELT pipelines. Connect a source stream to a destination with `Copy`, group one source's copies into one destination as a `Connection`, then execute the connections with `Pipeline`. It supports full refresh, incremental loading with persistent checkpoints, native change watching, and attachment extraction.

The core `elt` package holds the contracts and pipeline, uses Node.js APIs, and has no runtime dependencies. Each destination is its own package, together with its checkpoint store: `elt-sqlite` and `elt-postgresql`, which adds the `postgres` driver. The included Apple sources use macOS scripting and EventKit; the Google sources call REST APIs through `google-auth`. Transformations, queries, and search indexes belong in the application consuming the exported data.

[Quick start](#quick-start) · [Incremental sync](#incremental-sync) · [Watch for changes](#watch-for-changes) · [Reference](docs/reference.md)

## Sources and destinations

| Source                    | Available data                                                                                                                                                                                                                                                                                                                                                                           | Extraction                                                                                                                                                                                                                                                                           | Change trigger                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Apple Notes               | Accounts, folders, notes (text and Markdown, with checklists and tables), inline tags, mentions and note links, and attachments                                                                                                                                                                                                                                                          | Full refresh or snapshot incremental                                                                                                                                                                                                                                                 | Commits to Notes' own store; keeps Notes running hidden so iCloud changes arrive                                   |
| Apple Calendar            | Accounts, calendars, event occurrences, recurrence, alarms, attendees, and each item's iCalendar (ICS) components, properties and parameters                                                                                                                                                                                                                                             | Full refresh or snapshot incremental within a required date range                                                                                                                                                                                                                    | EventKit notifications                                                                                             |
| Apple Reminders           | Accounts, lists, reminders, date components, recurrence, alarms, and attendees                                                                                                                                                                                                                                                                                                           | Full refresh or snapshot incremental                                                                                                                                                                                                                                                 | EventKit notifications                                                                                             |
| Apple Messages            | Every column of chats, handles, participants, messages (text, edits, unsends, reactions, replies), Recently Deleted, and attachments with their files                                                                                                                                                                                                                                    | Full refresh or snapshot incremental, every stream from one consistent chat.db snapshot                                                                                                                                                                                              | Native filesystem notifications over `~/Library/Messages`                                                          |
| Apple Mail                | Accounts, mailboxes and memberships, messages and conversations, MIME bodies and headers, original EMLX files, attachments, rules, smart mailboxes, signatures and index metadata                                                                                                                                                                                                        | Full refresh or snapshot incremental over the complete local store                                                                                                                                                                                                                   | SQLite commits plus recursive filesystem notifications                                                             |
| Apple Contacts            | Accounts, groups and memberships, contacts (names, organization, birthdays including year-less and non-Gregorian ones, flags), notes, every labeled value (phones, emails, addresses, URLs, social profiles, instant messaging, related names, dates, calendar URIs), custom and unrecognized vCard properties, and contact photos with their bytes                                      | Full refresh or snapshot incremental, each account store read in one transaction                                                                                                                                                                                                     | Commits to Contacts' own stores, and accounts added or removed                                                     |
| Apple Safari              | History of every profile (pages, visits from this Mac and synced devices, redirects, deletions, topics), profiles, windows, tab groups, open and pinned tabs with their back and forward lists, iCloud Tabs, bookmarks, the Reading List, recently closed windows and tabs, and downloads with their files                                                                               | Full refresh or snapshot incremental, each database read in one transaction; a store that cannot be read fails only its streams                                                                                                                                                      | Commits to Safari's databases, and rewrites of its property lists                                                  |
| Apple Books               | Library (books, PDFs, series, reading progress, finished state), collections and members, highlights, underlines, notes and reading positions, reading state synced from other devices, daily reading time and monthly totals, reading streaks and goal, store purchases and custom themes, with each book file on this Mac (an EPUB package exported as one `.epub`)                    | Full refresh or snapshot incremental, each database read in one transaction; iCloud Drive placeholders are reported without being downloaded                                                                                                                                         | Commits to Books' and bookdatastored's databases, and rewrites of Books' preferences                               |
| Apple Activity            | Apps in focus and Screen Time app usage, menu use, app intents, web usage, Safari navigations, documents opened, media usage and Now Playing, Focus modes and suggestions, notification events, Bluetooth connections and screenshots, from this Mac and the devices it syncs with; screen-on spans and the device list. Rows stay after macOS drops them (28 days for most streams)     |
| Apple Accounts            | Every account in the system Accounts store (iCloud, Google, Exchange, IMAP, SMTP, CalDAV and others) with its parent, type, sign-in state, addresses, settings and properties (authentication material left out); the data classes each offers and has on; and the account types, data classes, access option keys, app authorizations and credential expiry                             | Full refresh or snapshot incremental, every stream from one store snapshot                                                                                                                                                                                                           | Commits to the Accounts store                                                                                      |
| Apple Call History        | Calls from Phone, FaceTime and the iPhone through iCloud (when, how long, phone or FaceTime, direction, answered, caller ID, junk and blocking, Apple's codes kept as stored), each call's other parties, the Phone app's call-time totals, and media shared during emergency calls                                                                                                      | Full refresh or snapshot incremental, every stream from one store snapshot, within an optional call-date range                                                                                                                                                                       | Commits to the call history store                                                                                  |
| Apple Clock               | Alarms, timers and saved/recent durations, sounds, world clocks, current stopwatch and laps, regional calendar records                                                                                                                                                                                                                                                                   | Full refresh or snapshot incremental over all saved local records                                                                                                                                                                                                                    | Commits to MobileTimer and replacements of Clock/daemon preferences                                                |
| Apple Notification Center | Every app's notifications Notification Center held when an import read it (title, subtitle, text, app, thread, category, the app's link to its own record, everything else as JSON), kept after Notification Center drops them, plus each app's badge and the notification categories and buttons it registered                                                                          | Full refresh or snapshot incremental, notifications never deleted, within an optional delivery-date range                                                                                                                                                                            | Commits to the Notification Center store                                                                           |
| Apple Wallet              | Every pass in Wallet on this Mac, with those iCloud brings from the iPhone (boarding passes, tickets, store and loyalty cards, coupons): issuer, kind, dates with the offset they were written in, every field front and back, barcodes, places and beacons, relevant dates, translations, images, and when Wallet added, updated and archived it                                        | Full refresh or snapshot incremental, a removed pass deleted                                                                                                                                                                                                                         | Commits to the Wallet store                                                                                        |
| Slack                     | What the Slack desktop app keeps for each signed-in workspace: workspaces, conversations (channels, DMs, group DMs) with their members, people, bots, apps, the messages and thread replies the app has loaded with their attachments, reactions and files (metadata), Slack List rows, sidebar sections, followed threads and preferences, kept after the app drops them from its cache | Full refresh or snapshot incremental from the app’s IndexedDB, a message deleted only where the app still holds the history, within an optional sent-date range                                                                                                                      | Saves of the Slack app’s state                                                                                     |
| Microsoft Teams           | What the Microsoft Teams app keeps for each signed-in work or school account: conversations (chats, meeting chats, teams, channels) with members and folders, the messages the app has loaded with reactions, mentions, files (metadata), links and quotes, pins, call history, activity, saved messages, people, meetings, installed apps and searches, kept after the app drops them   | Full refresh or snapshot incremental from the app’s IndexedDB, a message deleted only where the app still holds that part of the conversation, within an optional sent-date range                                                                                                    | Writes to the Teams app’s store                                                                                    |
| WhatsApp                  | What WhatsApp for Mac keeps: chats with group members and changes, messages it synced and received with their media (files it downloaded), replies, receipts, reactions and links, contacts, users with the phone number behind each LID, calls, statuses, business profiles, stickers, privacy settings and message timers                                                              | Full refresh or snapshot incremental from WhatsApp's own SQLite stores, a store that cannot be read failing only its streams, statuses kept after they expire, within an optional sent-date range                                                                                    | Commits to each WhatsApp store                                                                                     |
| Instagram                 | What instagram.com shows the account signed in to Instagram in the browser, for the profiles selected among those it follows: profiles, posts, the reels tab, reposts and tagged posts with every image (text read into `attachment_text`), comments and replies, stories, highlights, and the accounts it follows                                                                       | Snapshot incremental through instagram.com’s web API, each list scanned in parts over runs (10 pages a run) that delete only when the scan ends, stories kept after they expire, within an optional posted-date range                                                                | Hourly polling                                                                                                     |
| Google Search Console     | Properties, sitemaps, search analytics at four grains (daily totals per report type, queries, pages, countries), and URL inspection of every sitemap and search URL                                                                                                                                                                                                                      | Full refresh; incremental by date for the dated analytics grains, by snapshot for properties, sitemaps and the country breakdown, and rolling (never-inspected, then stalest, within the daily quota) for URL inspection; every row carries its property, so properties share tables | Change-gated polling (the API publishes no notification); the Google app runs one pass and does not watch          |
| SQL Server                | Every user table the login can read, one stream per table named `<schema>.<table>`, every value exact: decimal and money as exact decimals, bigint and rowversion as 64-bit integers, times to 100 ns, datetimeoffset as a UTC instant beside its offset, sql_variant beside its base type, binary as base64, spatial values with their SRID                                             | Change Tracking (inserts, updates, deletions) where the login can read it, else the table's rowversion (inserts and updates), else a full refresh; a first load resumes page by page, and a truncate or an expired history reloads the table behind its reader view                  | Polls the Change Tracking version and the database's last rowversion every 30 seconds; other tables refresh hourly |

Every destination supports overwrite, append, and deduplication:

- **SQLite** (`elt-sqlite`): strict tables with inferred or explicitly selected columns, including text and attachment bytes.
- **Postgres** (`elt-postgresql`): typed tables in one schema per connector, loaded without blocking readers, and [documented SQL views](docs/reference.md#documented-postgres-views) defined by the consuming application.

See the reference for [Mail streams](docs/reference.md#apple-mail), [Contacts streams](docs/reference.md#apple-contacts), [Calendar streams](docs/reference.md#apple-calendar), [Reminders streams](docs/reference.md#apple-reminders), [Safari streams](docs/reference.md#apple-safari), [Books streams](docs/reference.md#apple-books), [Activity streams](docs/reference.md#apple-activity), [Accounts streams](docs/reference.md#apple-accounts), [Call History streams](docs/reference.md#apple-call-history), [Clock streams](docs/reference.md#apple-clock), [Notification Center streams](docs/reference.md#apple-notification-center), [Wallet streams](docs/reference.md#apple-wallet), [Slack streams](docs/reference.md#slack), [Teams streams](docs/reference.md#microsoft-teams), [WhatsApp streams](docs/reference.md#whatsapp), [Instagram streams](docs/reference.md#instagram), [Search Console streams](docs/reference.md#google-search-console), [SQL Server streams](docs/reference.md#sql-server), and [destination behavior](docs/reference.md#identity-cursors-and-schemas).

## Quick start

### Library

[Context Compiler](https://github.com/ezzabuzaid/context-compiler) is the app built on elt: a Codex plugin and a CLI that set up, sync and query these sources on a Mac. This section uses the library directly.

Use **Node.js 26** and npm. The Apple sources require macOS; Calendar and Reminders require **macOS 27**, the release the EventKit helper is built for.

The packages are currently private npm workspaces. Use this checkout; the examples import its local `elt` package.

```sh
git clone https://github.com/ezzabuzaid/elt.git
cd elt
npm ci
```

The Notes source reads Notes' own store, `NoteStore.sqlite`, so Notes does not need to be open. macOS protects that store: allow the terminal app you run Nx from **Full Disk Access** in **System Settings → Privacy & Security → Full Disk Access**.

Every command runs through Nx. Its targets build their dependencies first and load the workspace `.env`.

A pipeline declares connections of copies; the smallest one copies Notes into SQLite:

```ts
import { mkdir } from 'node:fs/promises';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import { SQLiteDestination, SQLiteSyncHistory } from '@workspace/elt-sqlite';
import { AppleNotesSource } from '@workspace/source-apple-notes/apple-notes-source';

await mkdir('./outputs', { recursive: true });

const source = new AppleNotesSource();
const destination = new SQLiteDestination({
  path: './outputs/notes.sqlite',
});
const history = new SQLiteSyncHistory();
await history.install([destination]);

const pipeline = new Pipeline({
  history,
  connections: [
    new Connection({
      name: 'notes',
      source,
      destination,
      steps: [new Copy(source.notes, destination.table('notes'))],
    }),
  ],
});

await pipeline.run();
```

A copy like this replaces the `notes` table's contents with the current snapshot on every run. Columns are inferred from the source schema. Locked notes keep their title and dates; their text and Markdown remain `null`. Only Notes syncs iCloud notes on the Mac, so a run reads what Notes last synced; edits from other devices arrive once Notes runs.

`Copy` defaults to `full_refresh` extraction and `overwrite` loading. A `Connection` is one source's copies into one destination, with the checkpoints that resume them; its `name` is what sync history records. Creating a pipeline performs no extraction; `run()` executes it once and returns `{ copy, count, deleted }` results after loading. `count` is accepted input records, including deduplication no-ops, and `deleted` is accepted deletions, including keys that were already absent; neither is the number of changed rows.

### Connector registration

Each Apple source is its own package under [`packages/sources/apple`](packages/sources/apple) (`@workspace/source-apple-<name>`), written as if published to npm. [Context Compiler](https://github.com/ezzabuzaid/context-compiler/blob/main/docs/connectors-and-hosts.md) registers a connector for each source and loads it into its own SQLite import.

The [Google app](apps/google/src/main.ts) is one inline entry, like `apps/proactive`. It reads `sc-domain:ezz.sh` through one `SearchConsoleSource` and builds one `google-search-console` connection with a copy of every stream the source discovers. Each stream loads into `google_search_console.raw_<stream>`, and readers see it as the view `marts.search_console_<snake_stream>`. Each copy has the id `search-console:<stream>`. The app runs one pass and then stops. An error stops the app: Node prints the error and exits with status 1.

### Clock

`AppleClockSource` (`@workspace/source-apple-clock/apple-clock-source`) reads saved alarms, timers and recent durations, world clocks, the current stopwatch and its laps, sounds and regional calendar records. Open Clock once to create its stores; it need not stay open. Unchanged records are skipped and removed objects disappear from the destination. Resetting the stopwatch removes its laps; there is no recovered session history. Removing a recent timer can leave its stored duration marked invalid. See [Clock's ten streams, access requirements and live checks](docs/reference.md#apple-clock).

### Reminders

Reminders reads through EventKit, so Reminders.app need not be open. Grant the process running your script full access in **System Settings → Privacy & Security → Reminders**.

```ts
import { mkdir } from 'node:fs/promises';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import { SQLiteDestination, SQLiteSyncHistory } from '@workspace/elt-sqlite';
import { AppleRemindersSource } from '@workspace/source-apple-reminders/apple-reminders-source';

await mkdir('./outputs', { recursive: true });

const source = new AppleRemindersSource();
const destination = new SQLiteDestination({
  path: './outputs/reminders.sqlite',
});
const history = new SQLiteSyncHistory();
await history.install([destination]);

await new Pipeline({
  history,
  connections: [
    new Connection({
      name: 'reminders',
      source,
      destination,
      steps: [
        new Copy(source.reminders, destination.table('reminders')),
        new Copy(source.dateComponents, destination.table('dateComponents')),
      ],
    }),
  ],
}).run();
```

A full-refresh overwrite also removes deleted reminders; an incremental copy (`append_dedup` keyed by `id`, no `cursorField`) writes only changed reminders and deletes removed ones. Due and start dates are exported as raw date components, so date-only and floating reminders are never shifted into UTC. Apple exposes only the next incomplete occurrence of a recurring reminder. See [Reminders streams](docs/reference.md#apple-reminders) for all eight streams and their limits.

## Incremental sync

To retain the latest version of each note across runs, keep the quick-start imports and its source, destination and history setup, then replace the pipeline declaration and execution with:

```ts
import { SQLiteCheckpointStore } from '@workspace/elt-sqlite';

const checkpoints = new SQLiteCheckpointStore({
  path: './outputs/checkpoints.sqlite',
});

const pipeline = new Pipeline({
  history,
  connections: [
    new Connection({
      name: 'notes',
      source,
      destination,
      checkpoints,
      steps: [
        new Copy(source.notes, destination.table('notes'), {
          id: 'notes-to-sqlite',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        }),
      ],
    }),
  ],
});

await pipeline.run();
```

The Apple apps have no change feed, so an incremental copy compares each full scan with the snapshot saved by the previous run. The first run loads every note. Later runs write only new and changed notes and delete notes that disappeared, including edits that did not advance `modifiedAt`. These copies select no `cursorField` and need `append_dedup`, which deduplicates on the stream's own `id` key.

Keep the copy ID and both SQLite files between runs. The checkpoint store must use a separate file from the destination. A Postgres destination keeps its checkpoints beside the data instead, with `PostgresCheckpointStore` from `elt-postgresql`; see [checkpoint stores](docs/reference.md#checkpoint-stores). Changing the source, target or copy configuration requires a new copy ID or an explicit checkpoint reset. A changed stream schema starts the copy over on its own, and a destination table deleted by hand reloads from scratch.

**Notes reads its whole store on each run.** That takes milliseconds for thousands of notes; the comparison reduces writes. Notes in **Recently Deleted** are notes in that folder, so they stay until permanently deleted.

### Mail: local messages and attachments

```ts
import {
  AccountsStore,
  accountsStorePath,
} from '@workspace/sdk-apple-accounts';
import { mailDirectory } from '@workspace/sdk-apple-mail';
import { AppleMailSource } from '@workspace/source-apple-mail/apple-mail-source';

const mail = new AppleMailSource({
  path: mailDirectory,
  accounts: new AccountsStore(accountsStorePath),
});
await new Pipeline({
  history,
  connections: [
    new Connection({
      name: 'mail',
      source: mail,
      destination,
      steps: [
        new Copy(mail.messages, destination.table('mail_messages')),
        new Copy(mail.messageParts, destination.table('mail_parts')),
        new Copy(mail.messageMailboxes, destination.table('mail_mailboxes')),
      ],
    }),
  ],
}).run();
```

Mail reads all locally indexed history across the accounts on this Mac. `messageParts.text` preserves text and HTML bodies; `attachments.file` exposes every available decoded attachment, and `messageFiles.file` exposes the original EMLX. An indexed message or attachment that Mail has not downloaded keeps its metadata with `availableLocally: false` and null bytes. Only Mail downloads remote content. Keep Mail running for server changes to arrive; the watcher observes its local store without launching it. See [Mail streams and limits](docs/reference.md#apple-mail).

### Calendar: incremental with deletions

Calendar and Reminders load incrementally the same way:

```ts
import { AppleCalendarSource } from '@workspace/source-apple-calendar/apple-calendar-source';

const calendar = new AppleCalendarSource({
  startAt: '2026-09-01T00:00:00.000Z',
  endAt: '2026-12-01T00:00:00.000Z',
});

new Copy(calendar.events, destination.table('events'), {
  id: 'calendar-events',
  syncMode: 'incremental',
  destinationSyncMode: 'append_dedup',
});
```

Each run writes only new and changed rows and deletes rows that disappeared, including occurrences that moved out of the window and removed attendees or alarms. A copy that reads attachment files needs `attachments`; `googleCalendarAttachments(requester)` from `@workspace/source-apple-calendar/google-calendar-attachments` downloads those stored in Google Drive and Gmail through a `google-auth` requester. The window can move between runs without resetting the checkpoint. Calendar still reads the whole window every run. See [snapshot streams](docs/reference.md#snapshot-streams).

See [checkpoint and replay semantics](docs/reference.md#incremental-extraction-and-checkpoints).

## Watch for changes

For either pipeline above, replace its final execution statement with:

```ts
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

for await (const _ of pipeline.watch({ signal: controller.signal })) {
  // The data is already extracted, loaded, and checkpointed here.
}
```

Watching subscribes before the initial sync, then each connection runs a pass over the copies whose streams its source reported changed. Each iteration yields one pass, `{ connection, outcomes }`. Passes of one connection never overlap; passes of different connections run side by side, so a slow source never holds back another. Changes received during a pass or while you handle its results remain pending for that connection's next pass. The loop body is for application work after a sync; it does not need to extract or load anything.

Triggers are source-specific. Calendar and Reminders use EventKit notifications, which cover the whole event store: an edit in either app reruns watched copies of both. Notes checks its store's SQLite `data_version` every second, which changes with each commit Notes makes; filesystem notifications miss those commits while Notes keeps the store open. Only Notes syncs iCloud notes, so a Notes watch keeps Notes running: it launches Notes hidden and in the background when it starts, and every 30 seconds relaunches it the same way if it has stopped, whether you quit it or macOS closed it to free disk space. A Notes you have open is left as it is. Notes watching needs the same **Full Disk Access** as reading.

Calling `controller.abort()` stops observation and stops each in-flight pass, which is recorded `cancelled` and keeps what it committed. Breaking the loop also closes the watchers and stops their in-flight passes. A connection whose watcher fails stops alone while the others keep watching; once every connection has stopped or the signal aborts, the loop throws their errors together as a `WatchError`. An error that the sync history could not record stops every connection at once, and the loop throws that error itself. A stream whose load failed for a `system` reason loads again with no change after 10 seconds, then after 30, 90 and 270 seconds, until it fails five times in a row. Watchers preserve the configured extraction mode and do not add periodic reconciliation or a durable change feed.

Live verification confirmed that Calendar/Reminders writes through EventKit in a separate process reach SQLite through `Pipeline.watch()`: creation, updates, and removal were checked. A Notes edit made on an iPhone reached SQLite through a Notes watch once the watch had Notes running, and the watch relaunched Notes after it was closed. Native observer delivery and temporary-filesystem notifications are also tested. See [watching behavior and verification limits](docs/reference.md#watching-for-changes).

## Attachment text and local files

Using the `source` and `destination` from the quick start, store attachment metadata and parsed text in the database, and save original files in a directory you choose:

```ts
import { LocalFiles } from '@workspace/elt';
import { MacOSDocumentParser } from '@workspace/source-apple-macos/macos-document-parser';

const localFiles = new LocalFiles({ directory: './outputs/attachments' });

const attachments = new Copy(
  source.attachments,
  destination.table('attachments', (columns) => [
    columns.text('id'),
    columns.text('noteId'),
    columns
      .text('content')
      .from(source.attachments.file)
      .parse(new MacOSDocumentParser()),
    columns
      .text('attachmentRef')
      .from(source.attachments.file.store(localFiles)),
  ]),
);

await new Pipeline({
  history,
  connections: [
    new Connection({
      name: 'notes',
      source,
      destination,
      steps: [attachments],
    }),
  ],
}).run();
```

Each file field chooses its own store. SQLite and Postgres receive an ordinary text reference; `LocalFiles` owns paths and file writes. Files are saved before rows commit, and obsolete files are removed after committed rows stop referencing them. Unchanged content reuses its path; clearing a copy removes its managed files. These files mirror retained rows rather than form a permanent archive.

Parsing is explicit. Omitting file-derived columns loads metadata only. The macOS parser reads PDFs with a text layer, TXT, Markdown, RTF, HTML, DOC, DOCX, ODT, WordML, vCards, and text in images through Vision. Add `new AudioFormat(model)` to transcribe audio with a caller-provided AI SDK model; without it, audio loads `null`. `LocalTranscriptionModel` from `transcription-local` is such a model that runs on this Mac over Cohere Transcribe Arabic, which covers Arabic and English, installed by Handy; it needs `ffmpeg` on PATH (`brew install ffmpeg`), Nx builds its native worker with Rust/Cargo and CMake, and Handy's model downloads are reused in place and never modified. Video and unknown formats load `null`. Files it cannot read fail the copy. Attachments whose file is not on this Mac (not yet downloaded from iCloud) or that belong to a locked note keep their metadata with `null` content and reference. Tables have no file; their cells are in the note's `markdown`.

Context Compiler's hosts parse no file inside an import; they read the stored copies into an `attachment_text` table after each pass. See [attachment text](docs/reference.md#attachment-text).

See [file declarations, parsing, and attachment limitations](docs/reference.md#attachment-files-and-document-parsing).

## Sync modes

Extraction and loading are separate choices:

| `syncMode`     | `destinationSyncMode` | Behavior                                                             |
| -------------- | --------------------- | -------------------------------------------------------------------- |
| `full_refresh` | `overwrite`           | Replace the target with the current extraction. This is the default. |
| `full_refresh` | `append`              | Add every observation to existing data.                              |
| `full_refresh` | `overwrite_dedup`     | Replace the target, keeping the greatest cursor per key.             |
| `incremental`  | `append`              | Resume from saved state and retain every emitted observation.        |
| `incremental`  | `append_dedup`        | Resume from saved state and retain the greatest cursor per key.      |

Other combinations are rejected. An explicit options object requires both mode fields. Deduplication uses the key the stream declares; only for a stream that declares none does the copy select `primaryKey`. `cursor_newer` deduplication also requires `cursorField`, except on snapshot streams, which have no cursor field and deduplicate with `replace`. Incremental copies also require a stable `id` and checkpoint store.

A target has one writer, across every connection of a pipeline: a copy into a target another copy owns fails before it extracts anything, and dropping the target releases it. See [target ownership](docs/reference.md#target-ownership).

### Restated data

A deduplicating load resolves a key conflict with `dedupPolicy`:

| `dedupPolicy`            | Behavior                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `cursor_newer` (default) | Keep the row whose cursor sorts highest. Rejects out-of-order replay.                         |
| `replace`                | Let the newest extraction win. Required when an upstream restates facts it already published. |

A cursor that is itself part of the primary key is equal on every conflict, so `cursor_newer` could never update the conflicting row and a restatement would load as a silent no-op. Selecting that combination is rejected; choose `replace` instead. An example is an upstream that revises recent daily metrics and identifies each row by the same `date` that orders it.

## Failure behavior

- A pass is one source read over every stream its connection selected; streams may interleave, and each stages its rows apart from the others. `run()` makes one pass per connection, side by side. Each checkpoint is a commit point: the destination commits the rows before it, then the checkpoint is saved. A full refresh commits once, so a failure keeps its previous output.
- Data and state commits are separate, so delivery is **at least once**: retries can replay records since the last saved checkpoint. Deduplication reconciles replayed versions.
- Every copy runs even when one fails, and a failing connection or partition does not stop the others: each checkpoint commits, and the rest resume from theirs next run. `PipelineError` then lists every copy's committed counts and failures, per pass, and every connection whose pass could not run; it never implies rollback of what committed.
- There is no pipeline-wide rollback, automatic schema migration, or resumable full refresh. Streams agree with each other where the source pins one view of its upstream (Messages, Notes, Contacts, Calendar, Reminders); Search Console's streams are read independently.

See [execution and error handling](docs/reference.md#execution-and-failures).

## Permissions

Permissions apply to the process running the export, and a sandbox can still restrict access after permission is granted.

| Operation                    | Required access                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read or watch Apple Mail     | Full Disk Access (Mail's store and the system Accounts store, which holds account settings)                                                            |
| Read or watch Apple Notes    | Full Disk Access; Notes does not need to be open                                                                                                       |
| Read or watch Apple Contacts | Contacts access or Full Disk Access; Contacts does not need to be open                                                                                 |
| Read or watch Apple Safari   | Full Disk Access; Safari does not need to be open, but only Safari fetches history and tabs from other devices                                         |
| Read or watch Apple Books    | Full Disk Access; Books does not need to be open, and books kept only in iCloud are listed without their files                                         |
| Read or watch Mac activity   | Full Disk Access (Biome and knowledgeC); no app needs to be open                                                                                       |
| Read or watch Apple Accounts | Full Disk Access; no app needs to be open                                                                                                              |
| Read or watch Apple Clock    | Access to the protected database and city preferences, covered by Full Disk Access; stopwatch preferences were readable without that grant on macOS 27 |
| Read or watch Reminders      | Full Reminders access through EventKit                                                                                                                 |
| Read or watch Calendar       | Full Calendar access through EventKit                                                                                                                  |

Manage permissions in **System Settings → Privacy & Security**. Calendar and Reminders request access on the first native operation if it is undecided. A packaged process must provide the relevant usage descriptions and sandbox entitlements; see the [Reminders reference](docs/reference.md#apple-reminders).

## Development

```text
packages/elt/                     Core contracts, pipelines, and the checkpoint protocol
packages/destinations/sqlite/     SQLite destination and checkpoint store (elt-sqlite)
packages/destinations/postgresql/ Postgres destination and checkpoint store (elt-postgresql)
packages/google-auth/  Google OAuth grants, consent, refresh, and grant storage
packages/sdks/apple/      SDKs, one per Apple store (sdk-apple-<name>): accounts, biome,
                          books, call-history, clock, contacts, eventkit, knowledge, mail,
                          messages, notes, notification-center, safari,
                          wallet
packages/codecs/          One package per format (codec-<format>): plist, protobuf, segb,
                          leveldb, v8-serialization, chromium-indexeddb, sitemap,
                          apple-reference-date
packages/sdks/slack/desktop/    Slack desktop app SDK (sdk-slack-desktop)
packages/sources/slack/desktop/ Slack desktop app source (source-slack-desktop)
packages/sdks/microsoft/teams/    Microsoft Teams app SDK (sdk-microsoft-teams)
packages/sources/microsoft/teams/ Microsoft Teams app source (source-microsoft-teams)
packages/sdks/whatsapp/desktop/    WhatsApp for Mac SDK (sdk-whatsapp-desktop)
packages/sources/whatsapp/desktop/ WhatsApp for Mac source (source-whatsapp-desktop)
packages/sdks/chromium/cookies/   Chromium browser cookie store SDK (sdk-chromium-cookies)
packages/sdks/instagram/web/      instagram.com web API SDK (sdk-instagram-web)
packages/sources/instagram/web/   Instagram source (source-instagram-web)
packages/sources/apple/   One package per Apple source (source-apple-<name>), and the shared
                          source-apple-macos (readers, document parser)
packages/sdks/google/search-console/ Search Console API SDK (sdk-google-search-console)
packages/sources/google/  The Search Console source (source-google-search-console)
packages/sdks/microsoft/sql-server/    SQL Server SDK (sdk-microsoft-sql-server)
packages/sources/microsoft/sql-server/ SQL Server source (source-microsoft-sql-server)
packages/eca/              Event-condition-action rules over loaded data
packages/transcription-local/ Local audio transcription over Handy's models
apps/google/           Google example app over the Search Console source
apps/proactive/        Proactive rules over Calendar, Mail, Messages, Slack and WhatsApp
docs/                  Detailed behavior and native API research
infra/                 Local Postgres warehouse, optional MCP server and SQL Server
```

Run checks from the repository root:

```sh
npx nx run-many -t typecheck
npx nx run-many -t test
```

`build` and `typecheck` are inferred by the `@nx/js/typescript` plugin from each project's `tsconfig.json`, which extends `tsconfig.base.json` and references the workspace packages it imports; Nx keeps those references current before it runs either target. Typecheck first runs the project's `lint` target (ESLint, inferred by `@nx/eslint/plugin` from the root `eslint.config.mjs`), which runs its `format` target (Prettier, which rewrites files and sorts imports) first; each project opts in with `"format": {}` in its `project.json`. A pre-commit hook checks that the staged files are formatted, reading them as staged, and changes nothing, so a concurrent edit to the same checkout never reaches the commit; run `nx sync` yourself when a project's workspace dependencies change, since Nx refuses every task while the workspace is out of sync. Test targets build first and use Node's test runner. The EventKit package compiles the Swift `eventkit` helper (`sdk-apple-eventkit:helper`), which needs the Xcode Command Line Tools. Database integration tests require Docker. Their Nx targets run Node's test runner through `zukhruf-docker-tests`, and `@zukhruf/testing` creates or reuses PostgreSQL 18 and full SQL Server 2022 test servers on available ports. Each test acquires an isolated database directly and disposes its clients before the database; SQL Server permission tests also create and dispose their read-only logins. Full SQL Server runs emulated on Apple silicon so the tests cover Change Tracking, hierarchyid and spatial types. The supervisor cleans up run-owned containers, volumes, port forwards and temporary directories when a test process is killed. Databases inside shared servers are dropped by normal test disposal; after a forced kill, they remain until the shared server is stopped. Shared test servers remain available for later runs; list them with `docker ps --filter label=dev.zukhruf.testing.shared=1` and stop the chosen container with `docker stop <container-id>` when finished. Apple tests require macOS and an environment that permits native filesystem notifications. Calendar and Reminders tests share one "context-compiler tests" calendar and one reminders list, in the first EventKit account that accepts one, made on first use and never deleted, because iCloud brings a deleted calendar back, empty, hours later. A test holds them alone, across processes, through an exclusive SQLite transaction on `~/Library/Caches/context-compiler/eventkit-tests.sqlite`, empties the one it uses, reads its own events through the real helper, and empties it again. Where EventKit cannot produce a case (attendees, malformed documents, denied access, a missing ICS export), `StubEventKitHelper` (`@workspace/sdk-apple-eventkit/test`), a real executable, runs in place of the helper. One live test per store also reads this Mac's Calendar or Reminders read-only into a temporary SQLite database, skipped without access.

Put `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in the workspace `.env` (gitignored), then run the Search Console example with `npx nx run google:start`. It loads `sc-domain:ezz.sh` into the warehouse (`npx nx run infra:up`) in one pass, checkpoints included, and writes no local files. Readers see each stream as a [reader view](docs/reference.md#warehouse-marts) `marts.search_console_<snake_stream>`; an explicitly invoked consumer reads them directly through PostgreSQL as `agent_reader` (MCP is optional). Sync status and declared coverage are discoverable through `marts.catalog`; reading never starts a refresh. The first run opens a browser for Google consent; see [Search Console authorization](docs/reference.md#authorization) for the one-time OAuth client setup. `npx nx run google:test` runs the built app twice: once without the OAuth client, and once against the real API and the local warehouse. The second run needs the grant that an earlier `google:start` stored. It is a local test; CI does not run it.

SQL Server is available as an SDK and source package for library use; see [SQL Server](docs/reference.md#sql-server). A read-only login needs `db_datareader`, plus `VIEW CHANGE TRACKING` on tables whose changes it should read.

Run apps only through their Nx targets: `start` builds the app and its packages first and loads `.env`. Node's default TypeScript stripping does not support the parameter properties used here, so the targets run the built JavaScript.

To add a source, follow the [source-authoring guide](.agents/skills/add-elt-source/SKILL.md); its connector is then registered in [Context Compiler](https://github.com/ezzabuzaid/context-compiler). Implement discovery, validation, extraction, coverage, and change watching on `Source`; keep `Stream` as immutable metadata and reuse the pipeline's loading and checkpoint handling.

## Documentation

- [API and behavior reference](docs/reference.md): schemas, keys, cursors, checkpoints, attachments, storage guarantees, and complete source details.
- [EventKit Reminders notes](docs/eventkit-reminders.md): native API findings and implementation decisions.
- [Source-authoring guide](.agents/skills/add-elt-source/SKILL.md): repository conventions for implementing sources.
