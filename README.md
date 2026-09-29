# elt

**Extract data from native apps. Load it into SQLite, Postgres or Markdown. Keep it up to date.**

`elt` is a TypeScript library for declaring and running ELT pipelines. Connect a source stream to a destination with `Copy`, group one source's copies into one destination as a `Connection`, then execute the connections with `Pipeline`. It supports full refresh, incremental loading with persistent checkpoints, native change watching, and attachment extraction.

The core `elt` package holds the contracts and pipeline, uses Node.js APIs, and has no runtime dependencies. Each destination is its own package, together with its checkpoint store: `elt-sqlite`, `elt-markdown`, and `elt-postgresql`, which adds the `postgres` driver. The included Apple connectors use macOS scripting and EventKit; the Google connectors call REST APIs through `google-auth`. Transformations, queries, and search indexes belong in the application consuming the exported data.

[Quick start](#quick-start) · [Incremental sync](#incremental-sync) · [Watch for changes](#watch-for-changes) · [Reference](docs/reference.md)

## Sources and destinations

| Source | Available data | Extraction | Change trigger |
| --- | --- | --- | --- |
| Apple Notes | Accounts, folders, notes (text and Markdown, with checklists and tables), inline tags, mentions and note links, and attachments | Full refresh or snapshot incremental | Commits to Notes' own store; keeps Notes running hidden so iCloud changes arrive |
| Apple Calendar | Accounts, calendars, event occurrences, recurrence, alarms, attendees, and each item's iCalendar (ICS) components, properties and parameters | Full refresh or snapshot incremental within a required date range | EventKit notifications |
| Apple Reminders | Accounts, lists, reminders, date components, recurrence, alarms, and attendees | Full refresh or snapshot incremental | EventKit notifications |
| Apple Messages | Every column of chats, handles, participants, messages (text, edits, unsends, reactions, replies), Recently Deleted, and attachments with their files | Full refresh or snapshot incremental, every stream from one consistent chat.db snapshot | Native filesystem notifications over `~/Library/Messages` |
| Apple Mail | Accounts, mailboxes and memberships, messages and conversations, MIME bodies and headers, original EMLX files, attachments, rules, smart mailboxes, signatures and index metadata | Full refresh or snapshot incremental over the complete local store | SQLite commits plus recursive filesystem notifications |
| Apple Contacts | Accounts, groups and memberships, contacts (names, organization, birthdays including year-less and non-Gregorian ones, flags), notes, every labeled value (phones, emails, addresses, URLs, social profiles, instant messaging, related names, dates, calendar URIs), custom and unrecognized vCard properties, and contact photos with their bytes | Full refresh or snapshot incremental, each account store read in one transaction | Commits to Contacts' own stores, and accounts added or removed |
| Google Search Console | Properties, sitemaps, search analytics at four grains (daily totals per report type, queries, pages, countries), and URL inspection of every sitemap and search URL | Full refresh; incremental by date for the dated analytics grains, by snapshot for properties, sitemaps and the country breakdown, and rolling (never-inspected, then stalest, within the daily quota) for URL inspection; every row carries its property, so properties share tables | Change-gated polling (the API publishes no notification) |

Every destination supports overwrite, append, and deduplication:

- **SQLite** (`elt-sqlite`): strict tables with inferred or explicitly selected columns, including text and attachment bytes.
- **Postgres** (`elt-postgresql`): typed tables in one schema per connector, loaded without blocking readers, and [documented SQL views](docs/reference.md#documented-postgres-views) defined by the consuming application.
- **Markdown** (`elt-markdown`): one document per stream or one document per record, with managed append and deduplication.

See the reference for [Mail streams](docs/reference.md#apple-mail), [Contacts streams](docs/reference.md#apple-contacts), [Calendar streams](docs/reference.md#apple-calendar), [Reminders streams](docs/reference.md#apple-reminders), [Search Console streams](docs/reference.md#google-search-console), and [destination behavior](docs/reference.md#identity-cursors-and-schemas).

## Quick start

### Apple plugin for Codex

The [Apple plugin](plugins/apple/.codex-plugin/plugin.json) is a Codex plugin with setup and query skills and a local MCP server. Add this repository as a marketplace in Codex in the ChatGPT desktop app on a Mac (`codex plugin marketplace add ezzabuzaid/elt`), install **Apple**, then choose **Set up Apple**. Setup asks which apps and scopes to connect and explains macOS permissions. Users do not install Node, Docker or a repository: the launcher runs the server on the Node runtime bundled with the desktop app. The post-install setup prompt requires Codex 0.156 or later.

`plugins/apple` is the installable package, committed as Codex runs it; [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json) lists it. Its server is one bundled file, `plugins/apple/server.mjs`, built from `apps/apple/src/plugin` by `npx nx run apple:plugin`. `apple:test` rebuilds it, so commit the bundle with the source change that produced it.

The MCP tools only set up and sync. They import into `~/Library/Application Support/Context Compiler/Apple/<app>`: `data.sqlite` with an `_apple_catalog` table of schemas and coverage, checkpoints, and managed attachment copies. The query skill reads each `data.sqlite` directly with `sqlite3 -readonly`; the Codex sandbox also denies writes there. Sync runs on request while in use and records each app's status and last successful sync. Scope changes discard that app's previous imported copy. The setup skill can be run again to change or disconnect apps. It accesses content already available on the Mac; Calendar keeps remote attachment links without requiring Google sign-in. Scoped Mail omits global settings and native metadata streams whose ownership cannot be established. This desktop workflow is separate from the Postgres exporter described below.

### Library and exporter

Use **Node.js 26** and npm. The Apple connectors require macOS; Calendar and Reminders require **macOS 14 or later**.

The packages are currently private npm workspaces. Use this checkout; the examples import its local `elt` package.

```sh
git clone https://github.com/ezzabuzaid/elt.git
cd elt
npm ci
```

The Notes connector reads Notes' own store, `NoteStore.sqlite`, so Notes does not need to be open. macOS protects that store: allow the terminal app you run Nx from **Full Disk Access** in **System Settings → Privacy & Security → Full Disk Access**.

Every command runs through Nx. Its targets build their dependencies first and load the workspace `.env`. Start the warehouse and the Apple app:

```sh
npx nx run infra:up
npx nx run apple:start
```

A pipeline declares connections of copies; the smallest one copies Notes into SQLite:

```ts
import { mkdir } from 'node:fs/promises';
import { Connection, Copy, Pipeline } from 'elt';
import { SQLiteDestination } from 'elt-sqlite';
import { AppleNotesSource } from './sources/apple-notes/apple-notes-source.ts';

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

The repository also includes an [Apple exporter](apps/apple/src/main.ts) that loads every stream of every Apple connector incrementally: Mail, Notes, Messages, Contacts, Calendar and Reminders. Start the shared Postgres warehouse with `npx nx run infra:up`, then run `npx nx run apple:start`: it loads everything, then keeps the warehouse current until stopped. Each connector writes `raw_<stream>` tables in its own `apple_<name>` schema (for example `apple_notes.raw_notes`) and keeps checkpoints in that schema's `_mac_elt_checkpoints` table; a second run with no changes writes nothing. Streams with files load an absolute local file path as `attachmentRef`; the exporter does not parse file text. Original files live under `outputs/apple-<name>-files`, configured in [pipeline.ts](apps/apple/src/pipeline.ts). Apple raw schemas remain private. Every pass publishes documented sync outcomes and declared extraction coverage in `marts`, readable directly through PostgreSQL as `agent_reader`; Calendar's configured window remains queryable even with no matching events. See [warehouse metadata](docs/reference.md#warehouse-marts).

Each connector reads the app's own store at its default location, and each needs its own grant for the process running the export: Mail, Notes and Messages need Full Disk Access; Mail account settings also need Automation access to Mail; Contacts needs Contacts access or Full Disk Access; Calendar and Reminders need full Calendar and Reminders access, and Calendar's `calendars` stream also needs Automation access to Calendar. A connector the process cannot read causes exit status 1 while the others still load; a failed stream keeps its checkpoint and resumes from it next run. The apps produce no console output. Calendar loads occurrences from 2000-01-01 to a year after the process started and downloads attachments stored in Google Drive and Gmail, so it needs `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (the same Desktop client as `google:start`, with the Drive and Gmail APIs enabled); the first such download opens a browser for consent. See [Messages streams](docs/reference.md#apple-messages) and [Contacts streams](docs/reference.md#apple-contacts); Contacts account names (iCloud, Google) are not in its stores and do not load.

### Connector registration

[Apple's pipeline.ts](apps/apple/src/pipeline.ts) default-exports one hardcoded `Pipeline` with six connections, `apple-mail`, `apple-notes`, `apple-messages`, `apple-contacts`, `apple-calendar` and `apple-reminders`, each loading into its own `apple_<name>` schema with its checkpoints beside the data, and a `PostgresSyncHistory` that records every pass. It signs in to Google when the app starts, for Calendar's Drive and Gmail attachments, so `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` must be set. Add or remove connections there; no command-line arguments are needed.

- [main.ts](apps/apple/src/main.ts) (`npx nx run apple:start`), the app's one entry point, installs the sync history and watches the pipeline until `SIGINT` or `SIGTERM`. Every connection's first pass loads all its streams, side by side; after that each connection refreshes at its own source's pace, and every pass is recorded in the sync history as it completes. Stopping it after the first passes is a one-off load.

[Google connectors](apps/google/src/connectors.ts) default-exports a list of `{ name, run }` entries that `main.ts` calls in a plain loop. Each `run()` configures its own source, credentials, pipeline and post-load work: Search Console's builds a `Pipeline` with one `google-search-console` connection and a `PostgresSyncHistory`, then refreshes its marts after a complete or partial load.

### Reminders

Reminders reads through EventKit, so Reminders.app need not be open. Grant the process running your script full access in **System Settings → Privacy & Security → Reminders**.

```ts
import { mkdir } from 'node:fs/promises';
import { Connection, Copy, Pipeline } from 'elt';
import { SQLiteDestination } from 'elt-sqlite';
import { AppleRemindersSource } from './sources/apple-reminders/apple-reminders-source.ts';

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
import { SQLiteCheckpointStore } from 'elt-sqlite';

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

Keep the copy ID and both SQLite files between runs. The checkpoint store must use a separate file from the destination. A Postgres destination keeps its checkpoints beside the data instead, with `PostgresCheckpointStore` from `elt-postgresql`; see [checkpoint stores](docs/reference.md#checkpoint-stores). Changing the source, target, schema, or copy configuration requires a new copy ID or an explicit checkpoint reset. Reset the checkpoint if you delete or replace destination storage.

**Notes reads its whole store on each run.** That takes milliseconds for thousands of notes; the comparison reduces writes. Notes in **Recently Deleted** are notes in that folder, so they stay until permanently deleted.

### Mail: local messages and attachments

```ts
import { AppleMailSource } from './sources/apple-mail/apple-mail-source.ts';
import { mailDirectory } from './platform/macos/mail-store.ts';

const mail = new AppleMailSource(mailDirectory);
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
import { AppleCalendarSource } from './sources/apple-calendar/apple-calendar-source.ts';

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
import { MarkdownDestination } from 'elt-markdown';

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
import { LocalFiles } from 'elt';
import { MacOSDocumentParser } from './parsers/macos-document-parser.ts';

const localFiles = new LocalFiles({ directory: './outputs/attachments' });

const attachments = new Copy(
  source.attachments,
  destination.table('attachments', columns => [
    columns.text('id'),
    columns.text('noteId'),
    columns.text('content')
      .from(source.attachments.file)
      .parse(new MacOSDocumentParser()),
    columns.text('attachmentRef').from(source.attachments.file.store(localFiles)),
  ]),
);

await new Pipeline({
  connections: [
    new Connection({ name: 'notes', source, destination, steps: [attachments] }),
  ],
}).run();
```

Each file field chooses its own store. SQLite and Postgres receive an ordinary text reference; `LocalFiles` owns paths and file writes. Files are saved before rows commit, and obsolete files are removed after committed rows stop referencing them. Unchanged content reuses its path; clearing a copy removes its managed files. These files mirror retained rows rather than form a permanent archive.

Parsing is explicit. Omitting file-derived columns loads metadata only. The macOS parser reads PDFs with a text layer, TXT, Markdown, RTF, HTML, DOC, DOCX, ODT, WordML, vCards, and text in images through Vision. It does not transcribe audio; audio, video and unknown formats load `null`. Files it cannot read fail the copy. Attachments whose file is not on this Mac (not yet downloaded from iCloud) or that belong to a locked note keep their metadata with `null` content and reference. Tables have no file; their cells are in the note's `markdown`.

See [file declarations, parsing, and attachment limitations](docs/reference.md#attachment-files-and-document-parsing).

## Sync modes

Extraction and loading are separate choices:

| `syncMode` | `destinationSyncMode` | Behavior |
| --- | --- | --- |
| `full_refresh` | `overwrite` | Replace the target with the current extraction. This is the default. |
| `full_refresh` | `append` | Add every observation to existing data. |
| `full_refresh` | `overwrite_dedup` | Replace the target, keeping the greatest cursor per key. |
| `incremental` | `append` | Resume from saved state and retain every emitted observation. |
| `incremental` | `append_dedup` | Resume from saved state and retain the greatest cursor per key. |

Other combinations are rejected. An explicit options object requires both mode fields. Deduplication uses the key the stream declares; only for a stream that declares none does the copy select `primaryKey`. `cursor_newer` deduplication also requires `cursorField`, except on snapshot streams, which have no cursor field and deduplicate with `replace`. Incremental copies also require a stable `id` and checkpoint store.

A target has one writer, across every connection of a pipeline: a copy into a target another copy owns fails before it extracts anything, and dropping the target releases it. See [target ownership](docs/reference.md#target-ownership).

### Restated data

A deduplicating load resolves a key conflict with `dedupPolicy`:

| `dedupPolicy` | Behavior |
| --- | --- |
| `cursor_newer` (default) | Keep the row whose cursor sorts highest. Rejects out-of-order replay. |
| `replace` | Let the newest extraction win. Required when an upstream restates facts it already published. |

A cursor that is itself part of the primary key is equal on every conflict, so `cursor_newer` could never update the conflicting row and a restatement would load as a silent no-op. Selecting that combination is rejected; choose `replace` instead. Google Search Console is the worked example: it revises recent metrics, and its rows are identified by the same `date` it is ordered by.

## Failure behavior

- A pass is one source read over every stream its connection selected; streams may interleave, and each stages its rows apart from the others. `run()` makes one pass per connection, side by side. Each checkpoint is a commit point: the destination commits the rows before it, then the checkpoint is saved. A full refresh commits once, so a failure keeps its previous output.
- Data and state commits are separate, so delivery is **at least once**: retries can replay records since the last saved checkpoint. Deduplication reconciles replayed versions.
- Every copy runs even when one fails, and a failing connection or partition does not stop the others: each checkpoint commits, and the rest resume from theirs next run. `PipelineError` then lists every copy's committed counts and failures, per pass, and every connection whose pass could not run; it never implies rollback of what committed.
- There is no pipeline-wide rollback, automatic schema migration, or resumable full refresh. Streams agree with each other where the source pins one view of its upstream (Messages, Notes, Contacts, Calendar, Reminders); Search Console's streams are read independently.

See [execution and error handling](docs/reference.md#execution-and-failures).

## Permissions

Permissions apply to the process running the export, and a sandbox can still restrict access after permission is granted.

| Operation | Required access |
| --- | --- |
| Read or watch Apple Mail | Full Disk Access; account settings additionally require Automation access to Mail |
| Read or watch Apple Notes | Full Disk Access; Notes does not need to be open |
| Read or watch Apple Contacts | Contacts access or Full Disk Access; Contacts does not need to be open |
| Read or watch Reminders | Full Reminders access through EventKit |
| Read or watch Calendar | Full Calendar access through EventKit |
| Read Calendar `calendars` | Additional Automation access to Calendar |

Manage permissions in **System Settings → Privacy & Security**. Calendar and Reminders request access on the first native operation if it is undecided. Packaged hosts must provide the relevant usage descriptions and sandbox entitlements; see the [connector reference](docs/reference.md#apple-reminders).

## Development

```text
packages/elt/                     Core contracts, pipelines, and the checkpoint protocol
packages/destinations/sqlite/     SQLite destination and checkpoint store (elt-sqlite)
packages/destinations/markdown/   Markdown destination (elt-markdown)
packages/destinations/postgresql/ Postgres destination and checkpoint store (elt-postgresql)
packages/google-auth/  Google OAuth grants, consent, refresh, and grant storage
apps/apple/            Apple connectors, native bridges, document parser, and example app
apps/google/           Google connectors and example app
docs/                  Detailed behavior and native API research
infra/                 Local Postgres warehouse and optional MCP server
```

Run checks from the repository root:

```sh
npx nx run-many -t typecheck
npx nx run-many -t test
```

Typecheck targets also format and lint. Test targets build first and use Node's test runner. The `elt-postgresql` and `google` tests need Postgres: start it with `npx nx run infra:up`, or point `TEST_DATABASE_URL` at a server where the user can create databases and roles. Apple tests require macOS and an environment that permits native filesystem notifications; they use temporary files and unsaved/process-local EventKit objects, without modifying personal app data.

Put `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in the workspace `.env` (gitignored), then run the Search Console example with `npx nx run google:start`. It loads `sc-domain:ezz.sh` into the warehouse (`npx nx run infra:up`), checkpoints included, writes no local files, and installs the [agent-facing marts](docs/reference.md#warehouse-marts); an explicitly invoked consumer reads them directly through PostgreSQL as `agent_reader` (MCP is optional). Sync status and declared coverage are discoverable through `marts.catalog`; reading never starts a refresh. The first run opens a browser for Google consent; see [Search Console authorization](docs/reference.md#authorization) for the one-time OAuth client setup.

Run apps only through their Nx targets: `start` builds the app and its packages first and loads `.env`. Node's default TypeScript stripping does not support the parameter properties used here, so the targets run the built JavaScript.

To add a connector, follow the [source-authoring guide](.agents/skills/add-elt-source/SKILL.md). Implement discovery, validation, extraction, coverage, and change watching on `Source`; keep `Stream` as immutable metadata and reuse the pipeline's loading and checkpoint handling.

## Documentation

- [API and behavior reference](docs/reference.md): schemas, keys, cursors, checkpoints, attachments, storage guarantees, and complete connector details.
- [EventKit Reminders notes](docs/eventkit-reminders.md): native API findings and implementation decisions.
- [Source-authoring guide](.agents/skills/add-elt-source/SKILL.md): repository conventions for implementing connectors.
