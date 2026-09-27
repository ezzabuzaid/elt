# elt

**Extract data from native apps. Load it into SQLite, Postgres or Markdown. Keep it up to date.**

`elt` is a TypeScript library for declaring and running ELT pipelines. Connect a source stream to a destination with `Copy`, then execute the transfers with `Pipeline`. It supports full refresh, incremental loading with persistent checkpoints, native change watching, and attachment extraction.

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
- **Postgres** (`elt-postgresql`): typed tables in one schema per connector, loaded without blocking readers.
- **Markdown** (`elt-markdown`): one document per stream or one document per record, with managed append and deduplication.

See the reference for [Mail streams](docs/reference.md#apple-mail), [Contacts streams](docs/reference.md#apple-contacts), [Calendar streams](docs/reference.md#apple-calendar), [Reminders streams](docs/reference.md#apple-reminders), [Search Console streams](docs/reference.md#google-search-console), and [destination behavior](docs/reference.md#identity-cursors-and-schemas).

## Quick start

Use **Node.js 26** and npm. The Apple connectors require macOS; Calendar and Reminders require **macOS 14 or later**.

The packages are currently private npm workspaces. Use this checkout; the examples import its local `elt` package.

```sh
git clone https://github.com/ezzabuzaid/elt.git
cd elt
npm ci
```

The Notes connector reads Notes' own store, `NoteStore.sqlite`, so Notes does not need to be open. macOS protects that store: allow the process running your script **Full Disk Access** in **System Settings → Privacy & Security → Full Disk Access**.

Create `apps/apple/src/example.ts`:

```ts
import { mkdir } from 'node:fs/promises';
import { Copy, Pipeline } from 'elt';
import { SQLiteDestination } from 'elt-sqlite';
import { AppleNotesSource } from './sources/apple-notes/apple-notes-source.ts';

await mkdir('./outputs', { recursive: true });

const source = new AppleNotesSource();
const destination = new SQLiteDestination({
  path: './outputs/notes.sqlite',
});

const pipeline = new Pipeline({
  source,
  destination,
  steps: [new Copy(source.notes, destination.table('notes'))],
});

await pipeline.run();
```

Build and run from the repository root:

```sh
npx nx run apple:build
node apps/apple/dist/example.js
```

This writes `outputs/notes.sqlite`. Running it again replaces the `notes` table's contents with the current snapshot. Columns are inferred from the source schema. Locked notes keep their title and dates; their text and Markdown remain `null`. Only Notes syncs iCloud notes on the Mac, so a run reads what Notes last synced; edits from other devices arrive once Notes runs.

`Copy` defaults to `full_refresh` extraction and `overwrite` loading. Creating a pipeline performs no extraction; `run()` executes it once and returns `{ copy, count, deleted }` results after loading. `count` is accepted input records, including deduplication no-ops, and `deleted` is accepted deletions, including keys that were already absent; neither is the number of changed rows.

The repository also includes an [Apple exporter](apps/apple/src/main.ts) that loads every stream of every Apple connector incrementally: Mail, Notes, Messages, Contacts, Calendar and Reminders. Start the shared Postgres warehouse with `docker compose -f infra/docker-compose.yml up -d --wait`, then run `npx nx run apple:start`. Each connector writes `raw_<stream>` tables in its own `apple_<name>` schema (for example `apple_notes.raw_notes`) and keeps checkpoints in that schema's `_mac_elt_checkpoints` table; a second run with no changes writes nothing. Streams with files load their text as `content` and an absolute local file path as `attachmentRef`. Original files live under `outputs/apple-<name>-files`, configured in [connectors.ts](apps/apple/src/connectors.ts). Files without extractable text load with null `content`. Apple raw schemas use the warehouse's loader role and are not exposed through the read-only MCP's `marts` schema.

Each connector reads the app's own store at its default location, and each needs its own grant for the process running the export: Mail, Notes and Messages need Full Disk Access; Mail account settings also need Automation access to Mail; Contacts needs Contacts access or Full Disk Access; Calendar and Reminders need full Calendar and Reminders access, and Calendar's `calendars` stream also needs Automation access to Calendar. A connector the process cannot read causes exit status 1 while the others still load; a failed stream keeps its checkpoint and resumes from it next run. The apps produce no console output. Calendar loads occurrences from 2000-01-01 to a year after the run and downloads attachments stored in Google Drive and Gmail, so the run needs `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (the same Desktop client as `google:start`, with the Drive and Gmail APIs enabled); the first run opens a browser for consent. See [Messages streams](docs/reference.md#apple-messages) and [Contacts streams](docs/reference.md#apple-contacts); Contacts account names (iCloud, Google) are not in its stores and do not load.

### Connector registration

Each app's `src/connectors.ts` default-exports a list of `{ name, run }` entries. `main.ts` calls each entry in a plain loop, sets exit status 1 on failure, and continues with the next connector. Add or remove entries in [Apple connectors](apps/apple/src/connectors.ts) or [Google connectors](apps/google/src/connectors.ts); no command-line arguments are needed.

Each `run()` configures and runs its own ELT pipeline, so it can use any source, destination, and sync strategy. Credentials, discovery, and post-load work stay inside that function. For an already configured `pipeline`, an entry is:

```ts
export default [
  { name: 'notes', run: () => pipeline.run() },
];
```

Apple and Google remain separate apps with the same list shape. Their lists can be combined when the apps converge.

### Reminders

Reminders reads through EventKit, so Reminders.app need not be open. Grant the process running your script full access in **System Settings → Privacy & Security → Reminders**.

```ts
import { mkdir } from 'node:fs/promises';
import { Copy, Pipeline } from 'elt';
import { SQLiteDestination } from 'elt-sqlite';
import { AppleRemindersSource } from './sources/apple-reminders/apple-reminders-source.ts';

await mkdir('./outputs', { recursive: true });

const source = new AppleRemindersSource();
const destination = new SQLiteDestination({
  path: './outputs/reminders.sqlite',
});

await new Pipeline({
  source,
  destination,
  steps: [
    new Copy(source.reminders, destination.table('reminders')),
    new Copy(source.dateComponents, destination.table('dateComponents')),
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
  source,
  destination,
  checkpoints,
  steps: [
    new Copy(source.notes, destination.table('notes'), {
      id: 'notes-to-sqlite',
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
      primaryKey: ['id'],
    }),
  ],
});

await pipeline.run();
```

The Apple apps have no change feed, so an incremental copy compares each full scan with the snapshot saved by the previous run. The first run loads every note. Later runs write only new and changed notes and delete notes that disappeared, including edits that did not advance `modifiedAt`. These copies select no `cursorField` and need `append_dedup` keyed by `id`.

Keep the copy ID and both SQLite files between runs. The checkpoint store must use a separate file from the destination. A Postgres destination keeps its checkpoints beside the data instead, with `PostgresCheckpointStore` from `elt-postgresql`; see [checkpoint stores](docs/reference.md#checkpoint-stores). Changing the source, target, schema, or copy configuration requires a new copy ID or an explicit checkpoint reset. Reset the checkpoint if you delete or replace destination storage.

**Notes reads its whole store on each run.** That takes milliseconds for thousands of notes; the comparison reduces writes. Notes in **Recently Deleted** are notes in that folder, so they stay until permanently deleted.

### Mail: local messages and attachments

```ts
import { AppleMailSource } from './sources/apple-mail/apple-mail-source.ts';
import { mailDirectory } from './platform/macos/mail-store.ts';

const mail = new AppleMailSource(mailDirectory);
await new Pipeline({
  source: mail,
  destination,
  steps: [
    new Copy(mail.messages, destination.table('mail_messages')),
    new Copy(mail.messageParts, destination.table('mail_parts')),
    new Copy(mail.messageMailboxes, destination.table('mail_mailboxes')),
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
  primaryKey: ['id'],
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

Watching subscribes before the initial sync, then reruns affected copies when the source signals a change. Runs never overlap within one watcher. Changes received during a run or while you handle its results remain pending for another pass. The loop body is for application work after a sync; it does not need to extract or load anything.

Triggers are source-specific. Calendar and Reminders use EventKit notifications, which cover the whole event store: an edit in either app reruns watched copies of both. Notes checks its store's SQLite `data_version` every second, which changes with each commit Notes makes; filesystem notifications miss those commits while Notes keeps the store open. Only Notes syncs iCloud notes, so a Notes watch keeps Notes running: it launches Notes hidden and in the background when it starts, and every 30 seconds relaunches it the same way if it has stopped, whether you quit it or macOS closed it to free disk space. A Notes you have open is left as it is. Notes watching needs the same **Full Disk Access** as reading.

Calling `controller.abort()` stops observation and lets the current pass finish. Breaking the loop also closes the watcher. Watchers preserve the configured extraction mode and do not add retries, periodic reconciliation, or a durable change feed.

Live verification confirmed that Calendar/Reminders writes through EventKit in a separate process reach SQLite through `Pipeline.watch()`: creation, updates, and removal were checked. A Notes edit made on an iPhone reached SQLite through a Notes watch once the watch had Notes running, and the watch relaunched Notes after it was closed. Native observer delivery and temporary-filesystem notifications are also tested. See [watching behavior and verification limits](docs/reference.md#watching-for-changes).

## Markdown exports

Using the `source` from the quick start, create a separate pipeline with a Markdown destination:

```ts
import { MarkdownDestination } from 'elt-markdown';

const markdown = new MarkdownDestination({ path: './outputs/markdown' });

await new Pipeline({
  source,
  destination: markdown,
  steps: [
    new Copy(source.notes, markdown.folder('notes', { title: 'title' })),
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

await new Pipeline({ source, destination, steps: [attachments] }).run();
```

Each file field chooses its own store. SQLite and Postgres receive an ordinary text reference; `LocalFiles` owns paths and file writes. Files are saved before rows commit, and obsolete files are removed after committed rows stop referencing them. Unchanged content reuses its path; clearing a copy removes its managed files. These files mirror retained rows rather than form a permanent archive.

Parsing is explicit. Omitting file-derived columns loads metadata only. The macOS parser reads PDFs with a text layer, TXT, Markdown, RTF, HTML, DOC, DOCX, ODT, WordML, text in images through Vision, and speech in audio. Files it cannot read fail the copy. Attachments whose file is not on this Mac (not yet downloaded from iCloud) or that belong to a locked note keep their metadata with `null` content and reference. Tables have no file; their cells are in the note's `markdown`.

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

Other combinations are rejected. An explicit options object requires both mode fields. Deduplication requires `primaryKey` and `cursorField`; incremental copies also require a stable `id` and checkpoint store.

A target has one writer: a copy into a target another copy owns fails before it extracts anything, and dropping the target releases it. See [target ownership](docs/reference.md#target-ownership).

### Restated data

A deduplicating load resolves a key conflict with `dedupPolicy`:

| `dedupPolicy` | Behavior |
| --- | --- |
| `cursor_newer` (default) | Keep the row whose cursor sorts highest. Rejects out-of-order replay. |
| `replace` | Let the newest extraction win. Required when an upstream restates facts it already published. |

A cursor that is itself part of the primary key is equal on every conflict, so `cursor_newer` could never update the conflicting row and a restatement would load as a silent no-op. Selecting that combination is rejected; choose `replace` instead. Google Search Console is the worked example: it revises recent metrics, and its rows are identified by the same `date` it is ordered by.

## Failure behavior

- One run is one source read over every copy's stream; streams may interleave, and each stages its rows apart from the others. Each checkpoint is a commit point: the destination commits the rows before it, then the checkpoint is saved. A full refresh commits once, so a failure keeps its previous output.
- Data and state commits are separate, so delivery is **at least once**: retries can replay records since the last saved checkpoint. Deduplication reconciles replayed versions.
- Every copy runs even when one fails, and a failing partition does not stop the others: each checkpoint commits, and the rest resume from theirs next run. `PipelineError` then lists every copy's committed counts and failures; it never implies rollback of what committed.
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
infra/                 Local Postgres warehouse and the agent's MCP server
```

Run checks from the repository root:

```sh
npx nx run-many -t typecheck
npx nx run-many -t test
```

Typecheck targets also format and lint. Test targets build first and use Node's test runner. The `elt-postgresql` and `google` tests need Postgres: start it with `docker compose -f infra/docker-compose.yml up -d --wait`, or point `TEST_DATABASE_URL` at a server where the user can create databases and roles. Apple tests require macOS and an environment that permits native filesystem notifications; they use temporary files and unsaved/process-local EventKit objects, without modifying personal app data.

Run the Search Console example with `GOOGLE_OAUTH_CLIENT_ID=… GOOGLE_OAUTH_CLIENT_SECRET=… npx nx run google:start`. It loads `sc-domain:ezz.sh` into the compose warehouse, checkpoints included, and writes no local files (`docker compose -f infra/docker-compose.yml up -d --wait`) and installs the [agent-facing marts](docs/reference.md#warehouse-marts); an agent reads them through the `warehouse` MCP server in `.mcp.json`. The first run opens a browser for Google consent; see [Search Console authorization](docs/reference.md#authorization) for the one-time OAuth client setup.

Build with `npx nx run apple:build` before running Apple scripts. Nx builds the `elt` dependency first. Run the generated JavaScript: Node's default TypeScript stripping does not support the parameter properties used here.

To add a connector, follow the [source-authoring guide](.agents/skills/add-elt-source/SKILL.md). Implement discovery, validation, extraction, and change watching on `Source`; keep `Stream` as immutable metadata and reuse the pipeline's loading and checkpoint handling.

## Documentation

- [API and behavior reference](docs/reference.md): schemas, keys, cursors, checkpoints, attachments, storage guarantees, and complete connector details.
- [EventKit Reminders notes](docs/eventkit-reminders.md): native API findings and implementation decisions.
- [Source-authoring guide](.agents/skills/add-elt-source/SKILL.md): repository conventions for implementing connectors.
