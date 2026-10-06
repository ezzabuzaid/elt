# elt

**Extract data from native apps. Load it into SQLite, Postgres or Markdown. Keep it up to date.**

`elt` is a TypeScript library for declaring and running ELT pipelines. Connect a source stream to a destination with `Copy`, group one source's copies into one destination as a `Connection`, then execute the connections with `Pipeline`. It supports full refresh, incremental loading with persistent checkpoints, native change watching, and attachment extraction.

The core `elt` package holds the contracts and pipeline, uses Node.js APIs, and has no runtime dependencies. Each destination is its own package, together with its checkpoint store: `elt-sqlite`, `elt-markdown`, and `elt-postgresql`, which adds the `postgres` driver. The included Apple connectors use macOS scripting and EventKit; the Google connectors call REST APIs through `google-auth`. Transformations, queries, and search indexes belong in the application consuming the exported data.

[Quick start](#quick-start) · [Incremental sync](#incremental-sync) · [Watch for changes](#watch-for-changes) · [Reference](docs/reference.md)

## Sources and destinations

| Source                | Available data                                                                                                                                                                                                                                                                                                                                                                       | Extraction                                                                                                                                                                                                                                                                           | Change trigger                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Apple Notes           | Accounts, folders, notes (text and Markdown, with checklists and tables), inline tags, mentions and note links, and attachments                                                                                                                                                                                                                                                      | Full refresh or snapshot incremental                                                                                                                                                                                                                                                 | Commits to Notes' own store; keeps Notes running hidden so iCloud changes arrive     |
| Apple Calendar        | Accounts, calendars, event occurrences, recurrence, alarms, attendees, and each item's iCalendar (ICS) components, properties and parameters                                                                                                                                                                                                                                         | Full refresh or snapshot incremental within a required date range                                                                                                                                                                                                                    | EventKit notifications                                                               |
| Apple Reminders       | Accounts, lists, reminders, date components, recurrence, alarms, and attendees                                                                                                                                                                                                                                                                                                       | Full refresh or snapshot incremental                                                                                                                                                                                                                                                 | EventKit notifications                                                               |
| Apple Messages        | Every column of chats, handles, participants, messages (text, edits, unsends, reactions, replies), Recently Deleted, and attachments with their files                                                                                                                                                                                                                                | Full refresh or snapshot incremental, every stream from one consistent chat.db snapshot                                                                                                                                                                                              | Native filesystem notifications over `~/Library/Messages`                            |
| Apple Mail            | Accounts, mailboxes and memberships, messages and conversations, MIME bodies and headers, original EMLX files, attachments, rules, smart mailboxes, signatures and index metadata                                                                                                                                                                                                    | Full refresh or snapshot incremental over the complete local store                                                                                                                                                                                                                   | SQLite commits plus recursive filesystem notifications                               |
| Apple Contacts        | Accounts, groups and memberships, contacts (names, organization, birthdays including year-less and non-Gregorian ones, flags), notes, every labeled value (phones, emails, addresses, URLs, social profiles, instant messaging, related names, dates, calendar URIs), custom and unrecognized vCard properties, and contact photos with their bytes                                  | Full refresh or snapshot incremental, each account store read in one transaction                                                                                                                                                                                                     | Commits to Contacts' own stores, and accounts added or removed                       |
| Apple Safari          | History of every profile (pages, visits from this Mac and synced devices, redirects, deletions, topics), profiles, windows, tab groups, open and pinned tabs with their back and forward lists, iCloud Tabs, bookmarks, the Reading List, recently closed windows and tabs, and downloads with their files                                                                           | Full refresh or snapshot incremental, each database read in one transaction; a store that cannot be read fails only its streams                                                                                                                                                      | Commits to Safari's databases, and rewrites of its property lists                    |
| Apple Books           | Library (books, PDFs, series, reading progress, finished state), collections and members, highlights, underlines, notes and reading positions, reading state synced from other devices, daily reading time and monthly totals, reading streaks and goal, store purchases and custom themes, with each book file on this Mac (an EPUB package exported as one `.epub`)                | Full refresh or snapshot incremental, each database read in one transaction; iCloud Drive placeholders are reported without being downloaded                                                                                                                                         | Commits to Books' and bookdatastored's databases, and rewrites of Books' preferences |
| Apple Activity        | Apps in focus and Screen Time app usage, menu use, app intents, web usage, Safari navigations, documents opened, media usage and Now Playing, Focus modes and suggestions, notification events, Bluetooth connections and screenshots, from this Mac and the devices it syncs with; screen-on spans and the device list. Rows stay after macOS drops them (28 days for most streams) |
| Apple Accounts        | Every account in the system Accounts store (iCloud, Google, Exchange, IMAP, SMTP, CalDAV and others) with its parent, type, sign-in state, addresses, settings and properties (authentication material left out); the data classes each offers and has on; and the account types, data classes, access option keys, app authorizations and credential expiry                         | Full refresh or snapshot incremental, every stream from one store snapshot                                                                                                                                                                                                           | Commits to the Accounts store                                                        |
| Apple Call History    | Calls from Phone, FaceTime and the iPhone through iCloud (when, how long, phone or FaceTime, direction, answered, caller ID, junk and blocking, Apple's codes kept as stored), each call's other parties, the Phone app's call-time totals, and media shared during emergency calls                                                                                                  | Full refresh or snapshot incremental, every stream from one store snapshot, within an optional call-date range                                                                                                                                                                       | Commits to the call history store                                                    |
| Google Search Console | Properties, sitemaps, search analytics at four grains (daily totals per report type, queries, pages, countries), and URL inspection of every sitemap and search URL                                                                                                                                                                                                                  | Full refresh; incremental by date for the dated analytics grains, by snapshot for properties, sitemaps and the country breakdown, and rolling (never-inspected, then stalest, within the daily quota) for URL inspection; every row carries its property, so properties share tables | Change-gated polling (the API publishes no notification)                             |

Every destination supports overwrite, append, and deduplication:

- **SQLite** (`elt-sqlite`): strict tables with inferred or explicitly selected columns, including text and attachment bytes.
- **Postgres** (`elt-postgresql`): typed tables in one schema per connector, loaded without blocking readers, and [documented SQL views](docs/reference.md#documented-postgres-views) defined by the consuming application.
- **Markdown** (`elt-markdown`): one document per stream or one document per record, with managed append and deduplication.

See the reference for [Mail streams](docs/reference.md#apple-mail), [Contacts streams](docs/reference.md#apple-contacts), [Calendar streams](docs/reference.md#apple-calendar), [Reminders streams](docs/reference.md#apple-reminders), [Safari streams](docs/reference.md#apple-safari), [Books streams](docs/reference.md#apple-books), [Activity streams](docs/reference.md#apple-activity), [Accounts streams](docs/reference.md#apple-accounts), [Call History streams](docs/reference.md#apple-call-history), [Search Console streams](docs/reference.md#google-search-console), and [destination behavior](docs/reference.md#identity-cursors-and-schemas).

## Quick start

### Apple plugin for Codex

The [Apple plugin](plugins/apple/.codex-plugin/plugin.json) is a Codex plugin with setup and query skills and a local MCP server. To install it in Codex in the ChatGPT desktop app on a Mac:

1. Choose the **Plugins** icon in the sidebar, then **Add**, **Add a marketplace**.
2. Enter `ezzabuzaid/elt` as the source and choose **Add marketplace**. Git ref and sparse paths can stay empty.
3. Search for **Apple**, open it and choose **Install plugin**, then **Set up Apple**.

Setup asks in one form which connectors to import, each in full; a connector narrowed earlier in chat keeps that selection. Mail, Notes, Messages, Safari, Books, Activity, Accounts and Call History need Full Disk Access for ChatGPT, which macOS does not prompt for; when it is missing, setup reports those connectors as unavailable and a second form offers to open the Full Disk Access list in System Settings. Users do not install Node, Docker or a repository: the launcher runs the server on the Node runtime bundled with the desktop app. The terminal equivalent of steps 1–2 is `codex plugin marketplace add ezzabuzaid/elt`. The post-install setup prompt requires Codex 0.156 or later.

`plugins/apple` is the installable package, committed as Codex runs it; [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json) lists it. Its server, `plugins/apple/server`, is bundled from `apps/apple/plugin` by `apps/apple/plugin/build.mjs`: `main.mjs`, one folder per built-in connector, and the chunks they share. Only CI writes it: after each push to main that affects `apple-plugin`, the [Apple plugin bundle workflow](.github/workflows/apple-plugin.yml) runs `nx affected -t bundle -c release` and commits the server if it changed, so pull before your next push. A local `npx nx run apple-plugin:bundle`, which `apple-plugin:test` runs, builds into `dist/apps/apple/plugin/server`, and the end-to-end tests install `plugins/apple` with that server in place of the committed one.

The MCP tools only set up; the settings file's `selected_connectors` view lists each selected connector and where its import lives. Each selection imports into `~/Library/Application Support/Context Compiler/Apple/<connector>/<selection>`: `data.sqlite`, where each stream loads into a `raw_<stream>` table read through a described view, beside the `catalog`, `sync_status`, `stream_status` and `extraction_coverage` views elt-sqlite publishes, plus checkpoints and managed attachment copies. The query skill reads each `data.sqlite` directly with `sqlite3 -readonly`; the Codex sandbox also denies writes there. While Codex is open, one plugin server per Mac imports every selected connector once; an imported connector is not refreshed, and an import no pass loaded completely, such as one Codex closed during or one a full disk cut short, is retried. Setup returns once the answers are saved; a connector that has not finished its first import is reported as importing. Every pass is recorded in the connector's own file, so a reader judges freshness from the file it queries. A changed scope is a new import; the previous copy is removed. After install, the plugin's page in ChatGPT (Plugins › Apple) has a native Settings section, served through the `openai/settings` MCP extension: a Connectors group with a switch per connector and its sync status. The setup skill can be run again to change or disconnect connectors. It accesses content already available on the Mac; Calendar keeps remote attachment links without requiring Google sign-in. Scoped Mail omits global settings and native metadata streams whose ownership cannot be established.

### Apple CLI

[`apps/apple/cli`](apps/apple/cli/src/main.ts) reads the same Apple connectors from a terminal, into its own store under `outputs/cli`, separate from the plugin's. Run it with `npx nx run apple-cli:start -- <command>`:

- `setup` asks which connectors to import and, optionally, which accounts, collections and dates to narrow each one to; `setup --connector notes --collection <id> --since 2025-01-01 --connector mail` does the same without prompts, each narrowing flag applying to the `--connector` before it, and `options <connector>` lists the IDs. Changing a connector's selection removes its import, so the next sync loads it again.
- `sync` loads every selected connector once, showing each stream's progress; run it again to refresh. A second sync of the same store waits up to five seconds for the running one to finish, then is refused; `status` never keeps a sync from starting. Ctrl-C stops a sync at once with exit status 130; what it committed stays, `status` shows the pass as interrupted, and the next sync resumes it.
- `status` reports each connector's latest pass, last success and database; a pass that was stopped, and with `--json` each stream it was loading, shows as interrupted.
- `query <connector> --tables` lists each stream's view, its rows and its declared coverage, and `query <connector> "<sql>"` runs one read-only statement. Each connector's `catalog` view lists every view and column with its description.

Each import's `outputs/cli/<connector>/<selection>/data.sqlite` holds `raw_<stream>` tables read through described views named after their streams (`inline_attachments` for `inlineAttachments`), with the sync history and `catalog` views elt-sqlite publishes. macOS grants access to the terminal app that runs the CLI, so it needs its own Full Disk Access, Contacts, Calendar and Reminders grants; a connector denied access fails alone and names the grant. Without a terminal, or with `--json`, output is JSON (one line per pass for `sync`) and nothing prompts.

Calendar reads occurrences from 2000-01-01 to a year ahead unless the selection narrows the dates, and its import downloads attachments stored in Google Drive and Gmail. That needs `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (the same Desktop client as `google:start`, with the Drive and Gmail APIs enabled); the first Calendar sync opens a browser for consent. Contacts account names (iCloud, Google) are not in its stores and do not load.

### Library

Use **Node.js 26** and npm. The Apple connectors require macOS; Calendar and Reminders require **macOS 27**, the release the EventKit helper is built for.

The packages are currently private npm workspaces. Use this checkout; the examples import its local `elt` package.

```sh
git clone https://github.com/ezzabuzaid/elt.git
cd elt
npm ci
```

The Notes connector reads Notes' own store, `NoteStore.sqlite`, so Notes does not need to be open. macOS protects that store: allow the terminal app you run Nx from **Full Disk Access** in **System Settings → Privacy & Security → Full Disk Access**.

Every command runs through Nx. Its targets build their dependencies first and load the workspace `.env`. Choose the Apple connectors to import, then load them:

```sh
npx nx run apple-cli:start -- setup
npx nx run apple-cli:start -- sync
```

A pipeline declares connections of copies; the smallest one copies Notes into SQLite:

```ts
import { mkdir } from 'node:fs/promises';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import { SQLiteDestination } from '@workspace/elt-sqlite';
import { AppleNotesSource } from '@workspace/source-apple-notes/apple-notes-source';

await mkdir('./outputs', { recursive: true });

const source = new AppleNotesSource();
const destination = new SQLiteDestination({
  path: './outputs/notes.sqlite',
});

const pipeline = new Pipeline({
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

Each Apple source is its own package under [`packages/sources/apple`](packages/sources/apple) (`@workspace/source-apple-<name>`), written as if published to npm. The Apple connectors live in [`packages/connectors/apple`](packages/connectors/apple), one package each (`@workspace/connector-apple-<name>`) whose `package.json` is its manifest: a `contextCompiler` field with the connector's name and title, and `exports` naming its `AppleConnector` class, which imports its source package. The [CLI](apps/apple/cli/src/main.ts) and the [plugin](apps/apple/plugin/src/main.ts) discover them through [`connector-apple-manifest`](packages/connectors/apple/manifest/src/connectors.ts), and then the user's own connectors in `~/Library/Application Support/Context Compiler/Connectors`, which run on the host's `elt` and `AppleConnector`. Both load each selected connector into its own SQLite import.

[Google connectors](apps/google/src/connectors.ts) default-exports a list of `{ name, run }` entries that `main.ts` calls in a plain loop. Each `run()` configures its own source, credentials, pipeline and post-load work: Search Console's builds a `Pipeline` with one `google-search-console` connection and a `PostgresSyncHistory`, then publishes its marts after a complete or partial load, once every raw table exists.

### Reminders

Reminders reads through EventKit, so Reminders.app need not be open. Grant the process running your script full access in **System Settings → Privacy & Security → Reminders**.

```ts
import { mkdir } from 'node:fs/promises';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import { SQLiteDestination } from '@workspace/elt-sqlite';
import { AppleRemindersSource } from '@workspace/source-apple-reminders/apple-reminders-source';

await mkdir('./outputs', { recursive: true });

const source = new AppleRemindersSource();
const destination = new SQLiteDestination({
  path: './outputs/reminders.sqlite',
});

await new Pipeline({
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

To retain the latest version of each note across runs, keep the quick-start imports and source/destination setup, then replace the pipeline declaration and execution with:

```ts
import { SQLiteCheckpointStore } from '@workspace/elt-sqlite';

const checkpoints = new SQLiteCheckpointStore({
  path: './outputs/checkpoints.sqlite',
});

const pipeline = new Pipeline({
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
import { AppleMailSource } from '@workspace/source-apple-mail/apple-mail-source';
import { mailDirectory } from '@workspace/source-apple-mail/mail-store';

const mail = new AppleMailSource({
  path: mailDirectory,
  accounts: new AccountsStore(accountsStorePath),
});
await new Pipeline({
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

Each run writes only new and changed rows and deletes rows that disappeared, including occurrences that moved out of the window and removed attendees or alarms. The window can move between runs without resetting the checkpoint. Calendar still reads the whole window every run. See [snapshot streams](docs/reference.md#snapshot-streams).

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

Calling `controller.abort()` stops observation and lets each in-flight pass finish. Breaking the loop also closes the watchers. A connection whose watcher fails stops alone while the others keep watching; once every connection has stopped or the signal aborts, the loop throws their errors together as an `AggregateError`. Watchers preserve the configured extraction mode and do not add retries, periodic reconciliation, or a durable change feed.

Live verification confirmed that Calendar/Reminders writes through EventKit in a separate process reach SQLite through `Pipeline.watch()`: creation, updates, and removal were checked. A Notes edit made on an iPhone reached SQLite through a Notes watch once the watch had Notes running, and the watch relaunched Notes after it was closed. Native observer delivery and temporary-filesystem notifications are also tested. See [watching behavior and verification limits](docs/reference.md#watching-for-changes).

## Markdown exports

Using the `source` from the quick start, create a separate connection with a Markdown destination:

```ts
import { MarkdownDestination } from '@workspace/elt-markdown';

const markdown = new MarkdownDestination({ path: './outputs/markdown' });

await new Pipeline({
  connections: [
    new Connection({
      name: 'notes-markdown',
      source,
      destination: markdown,
      steps: [
        new Copy(source.notes, markdown.folder('notes', { title: 'title' })),
      ],
    }),
  ],
}).run();
```

`folder()` creates one document per record. Use `markdown.file('notes.md', { title: 'title' })` for one combined document. Both support incremental deduplication with the same copy options and a separate checkpoint store.

Generated Markdown retains canonical record data for subsequent appends and reconciliation. Treat these files as managed output: manual edits are replaced. See [Markdown storage and recovery](docs/reference.md#markdown-destination).

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

Parsing is explicit. Omitting file-derived columns loads metadata only. The macOS parser reads PDFs with a text layer, TXT, Markdown, RTF, HTML, DOC, DOCX, ODT, WordML, vCards, and text in images through Vision. It does not transcribe audio; audio, video and unknown formats load `null`. Files it cannot read fail the copy. Attachments whose file is not on this Mac (not yet downloaded from iCloud) or that belong to a locked note keep their metadata with `null` content and reference. Tables have no file; their cells are in the note's `markdown`.

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

A cursor that is itself part of the primary key is equal on every conflict, so `cursor_newer` could never update the conflicting row and a restatement would load as a silent no-op. Selecting that combination is rejected; choose `replace` instead. Google Search Console is the worked example: it revises recent metrics, and its rows are identified by the same `date` it is ordered by.

## Failure behavior

- A pass is one source read over every stream its connection selected; streams may interleave, and each stages its rows apart from the others. `run()` makes one pass per connection, side by side. Each checkpoint is a commit point: the destination commits the rows before it, then the checkpoint is saved. A full refresh commits once, so a failure keeps its previous output.
- Data and state commits are separate, so delivery is **at least once**: retries can replay records since the last saved checkpoint. Deduplication reconciles replayed versions.
- Every copy runs even when one fails, and a failing connection or partition does not stop the others: each checkpoint commits, and the rest resume from theirs next run. `PipelineError` then lists every copy's committed counts and failures, per pass, and every connection whose pass could not run; it never implies rollback of what committed.
- There is no pipeline-wide rollback, automatic schema migration, or resumable full refresh. Streams agree with each other where the source pins one view of its upstream (Messages, Notes, Contacts, Calendar, Reminders); Search Console's streams are read independently.

See [execution and error handling](docs/reference.md#execution-and-failures).

## Permissions

Permissions apply to the process running the export, and a sandbox can still restrict access after permission is granted.

| Operation                    | Required access                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Read or watch Apple Mail     | Full Disk Access (Mail's store and the system Accounts store, which holds account settings)                    |
| Read or watch Apple Notes    | Full Disk Access; Notes does not need to be open                                                               |
| Read or watch Apple Contacts | Contacts access or Full Disk Access; Contacts does not need to be open                                         |
| Read or watch Apple Safari   | Full Disk Access; Safari does not need to be open, but only Safari fetches history and tabs from other devices |
| Read or watch Apple Books    | Full Disk Access; Books does not need to be open, and books kept only in iCloud are listed without their files |
| Read or watch Mac activity   | Full Disk Access (Biome and knowledgeC); no app needs to be open                                               |
| Read or watch Apple Accounts | Full Disk Access; no app needs to be open                                                                      |
| Read or watch Reminders      | Full Reminders access through EventKit                                                                         |
| Read or watch Calendar       | Full Calendar access through EventKit                                                                          |

Manage permissions in **System Settings → Privacy & Security**. Calendar and Reminders request access on the first native operation if it is undecided. Packaged hosts must provide the relevant usage descriptions and sandbox entitlements; see the [connector reference](docs/reference.md#apple-reminders).

## Development

```text
packages/elt/                     Core contracts, pipelines, and the checkpoint protocol
packages/destinations/sqlite/     SQLite destination and checkpoint store (elt-sqlite)
packages/destinations/markdown/   Markdown destination (elt-markdown)
packages/destinations/postgresql/ Postgres destination and checkpoint store (elt-postgresql)
packages/google-auth/  Google OAuth grants, consent, refresh, and grant storage
packages/sdks/apple/      SDKs, one per Apple store or format (sdk-apple-<name>): accounts,
                          app-database, books, call-history, contacts, eventkit,
                          messages, notes, plist, safari, segb
packages/codecs/          Formats several SDKs decode: protobuf (codec-protobuf)
packages/sources/apple/   One package per Apple source (source-apple-<name>), and the shared
                          source-apple-macos (readers, document parser)
packages/sources/google/  The Search Console source (source-google-search-console)
packages/connectors/apple/ One package per Apple connector (connector-apple-<name>), with
                           AppleConnector (connector-apple-connector) and discovery
                           (connector-apple-manifest)
apps/apple/plugin/     Codex plugin server, bundled into plugins/apple/server (apple-plugin)
apps/apple/cli/        Terminal CLI over the Apple connectors: setup, sync, status, query (apple-cli)
apps/google/           Google example app over the Search Console source
docs/                  Detailed behavior and native API research
infra/                 Local Postgres warehouse and optional MCP server
```

Run checks from the repository root:

```sh
npx nx run-many -t typecheck
npx nx run-many -t test
```

`build` and `typecheck` are inferred by the `@nx/js/typescript` plugin from each project's `tsconfig.json`, which extends `tsconfig.base.json` and references the workspace packages it imports; Nx keeps those references current before it runs either target. Typecheck first runs the project's `lint` target (ESLint, inferred by `@nx/eslint/plugin` from the root `eslint.config.mjs`), which runs its `format` target (Prettier, which rewrites files and sorts imports) first; each project opts in with `"format": {}` in its `project.json`. A pre-commit hook runs `nx sync` and formats staged files that no project covers. Test targets build first and use Node's test runner. The EventKit package compiles the Swift `eventkit` helper (`sdk-apple-eventkit:helper`), which needs the Xcode Command Line Tools. The `elt-postgresql` and `source-google-search-console` tests need Postgres: start it with `npx nx run infra:up`, or point `TEST_DATABASE_URL` at a server where the user can create databases and roles. Each test creates a database of its own on that server (`scratchDatabase`, or `scratchWarehouse` provisioned by `infra/init/marts/contract.sql` for reading as `agent_reader`). Apple tests require macOS and an environment that permits native filesystem notifications. Calendar and Reminders tests create a temporary calendar or reminders list through EventKit, in the first account that accepts one, read it through the real helper and delete it; the account syncs it to its server until then. Where EventKit cannot produce a case (attendees, malformed documents, denied access, a missing ICS export), `StubEventKitHelper` (`@workspace/sdk-apple-eventkit/test`), a real executable, runs in place of the helper. One live test per store also reads this Mac's Calendar or Reminders read-only into a temporary SQLite database, skipped without access.

Put `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in the workspace `.env` (gitignored), then run the Search Console example with `npx nx run google:start`. It loads `sc-domain:ezz.sh` into the warehouse (`npx nx run infra:up`), checkpoints included, writes no local files, and installs the [agent-facing marts](docs/reference.md#warehouse-marts); an explicitly invoked consumer reads them directly through PostgreSQL as `agent_reader` (MCP is optional). Sync status and declared coverage are discoverable through `marts.catalog`; reading never starts a refresh. The first run opens a browser for Google consent; see [Search Console authorization](docs/reference.md#authorization) for the one-time OAuth client setup.

Run apps only through their Nx targets: `start` builds the app and its packages first and loads `.env`. Node's default TypeScript stripping does not support the parameter properties used here, so the targets run the built JavaScript.

To add a connector, follow the [source-authoring guide](.agents/skills/add-elt-source/SKILL.md). Implement discovery, validation, extraction, coverage, and change watching on `Source`; keep `Stream` as immutable metadata and reuse the pipeline's loading and checkpoint handling.

## Documentation

- [API and behavior reference](docs/reference.md): schemas, keys, cursors, checkpoints, attachments, storage guarantees, and complete connector details.
- [EventKit Reminders notes](docs/eventkit-reminders.md): native API findings and implementation decisions.
- [Source-authoring guide](.agents/skills/add-elt-source/SKILL.md): repository conventions for implementing connectors.
