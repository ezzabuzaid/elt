# elt

**Extract data from native apps. Load it into SQLite or Markdown. Keep it up to date.**

`elt` is a TypeScript library for declaring and running ELT pipelines. Connect a source stream to a destination with `Copy`, then execute the transfers with `Pipeline`. It supports full refresh, incremental loading with persistent checkpoints, native change watching, and attachment extraction.

The core uses Node.js APIs with no runtime dependencies. The included Apple connectors use macOS scripting and EventKit; the Google connectors call REST APIs through `google-auth`. Transformations, queries, and search indexes belong in the application consuming the exported data.

[Quick start](#quick-start) · [Incremental sync](#incremental-sync) · [Watch for changes](#watch-for-changes) · [Reference](docs/reference.md)

## Sources and destinations

| Source | Available data | Extraction | Change trigger |
| --- | --- | --- | --- |
| Apple Notes | Accounts, folders, notes, and attachments | Full refresh or snapshot incremental | Native filesystem notifications over Notes storage |
| Apple Calendar | Accounts, calendars, event occurrences, recurrence, alarms, attendees, scripting metadata, and each item's iCalendar (ICS) components, properties and parameters | Full refresh or snapshot incremental within a required date range | EventKit notifications |
| Apple Reminders | Accounts, lists, reminders, date components, recurrence, alarms, and attendees | Full refresh or snapshot incremental | EventKit notifications |
| Google Search Console | Properties, sitemaps, search analytics at four grains (daily totals per report type, queries, pages, countries), and URL inspection | Full refresh; incremental by date for the dated analytics grains and by snapshot for properties, sitemaps, the country breakdown and URL inspection; every row carries its property, so properties share tables | Change-gated polling (the API publishes no notification) |

Both destinations support overwrite, append, and deduplication:

- **SQLite:** strict tables with inferred or explicitly selected columns, including text and attachment bytes.
- **Markdown:** one document per stream or one document per record, with managed append and deduplication.

See the reference for [Calendar streams](docs/reference.md#apple-calendar), [Reminders streams](docs/reference.md#apple-reminders), [Search Console streams](docs/reference.md#google-search-console), and [destination behavior](docs/reference.md#identity-cursors-and-schemas).

## Quick start

Use **Node.js 26** and npm. The Apple connectors require macOS; Calendar and Reminders require **macOS 14 or later**.

The packages are currently private npm workspaces. Use this checkout; the examples import its local `elt` package.

```sh
git clone https://github.com/ezzabuzaid/elt.git
cd elt
npm ci
```

Open Notes and allow the process running your script to access it through **System Settings → Privacy & Security → Automation** when prompted.

Create `apps/apple/src/example.ts`:

```ts
import { mkdir } from 'node:fs/promises';
import { Copy, Pipeline, SQLiteDestination } from 'elt';
import { AppleNotesSource } from './index.ts';

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

const results = await pipeline.run();
console.table(results.map(({ copy, count, deleted }) => ({
  stream: copy.from.name,
  processed: count,
  deleted,
})));
```

Build and run from the repository root:

```sh
npx nx run apple:build
node apps/apple/dist/example.js
```

This writes `outputs/notes.sqlite`. Running it again replaces the `notes` table's contents with the current snapshot. Columns are inferred from the source schema. Password-protected note bodies remain `null`.

`Copy` defaults to `full_refresh` extraction and `overwrite` loading. Creating a pipeline performs no extraction; `run()` executes it once and returns `{ copy, count, deleted }` results after loading. `count` is accepted input records, including deduplication no-ops, and `deleted` is accepted deletions, including keys that were already absent; neither is the number of changed rows.

The repository also includes a [Notes exporter](apps/apple/src/main.ts) that loads accounts, folders, notes, and attachment metadata, text, and bytes. Run it with `npx nx run apple:start`. It writes `outputs/apple-notes.sqlite`; unsupported attachment formats or export failures stop the affected copy.

### Reminders

Reminders reads through EventKit, so Reminders.app need not be open. Grant the process running your script full access in **System Settings → Privacy & Security → Reminders**.

```ts
import { mkdir } from 'node:fs/promises';
import { Copy, Pipeline, SQLiteDestination } from 'elt';
import { AppleRemindersSource } from './index.ts';

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
import { SQLiteCheckpointStore } from 'elt';

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

Keep the copy ID and both SQLite files between runs. The checkpoint store must use a separate file from the destination. Changing the source, target, schema, or copy configuration requires a new copy ID or an explicit checkpoint reset. Reset the checkpoint if you delete or replace destination storage.

**Notes still scans the full collection.** The comparison reduces writes, not the source scan cost. Notes returns notes in **Recently Deleted**, so they stay until permanently deleted.

### Calendar: incremental with deletions

Calendar and Reminders load incrementally the same way:

```ts
import { AppleCalendarSource } from './index.ts';

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

For either pipeline above, replace its final execution and logging statements with:

```ts
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

for await (const results of pipeline.watch({ signal: controller.signal })) {
  // The data is already extracted, loaded, and checkpointed here.
  console.table(results.map(({ copy, count, deleted }) => ({
    stream: copy.from.name,
    processed: count,
    deleted,
  })));
}
```

Watching subscribes before the initial sync, then reruns affected copies when the source signals a change. Runs never overlap within one watcher. Changes received during a run or while you handle its results remain pending for another pass. The loop body is for application work after a sync; it does not need to extract or load anything.

Triggers are source-specific. Calendar and Reminders use EventKit notifications, which cover the whole event store: an edit in either app reruns watched copies of both. Notes watches its protected storage directory using native filesystem notifications, which can also fire for unrelated storage activity. Notes watching may require **Full Disk Access** for the host process, in addition to Automation permission for reading. Access failures are reported; there is no polling fallback.

Calling `controller.abort()` stops observation and lets the current pass finish. Breaking the loop also closes the watcher. Watchers preserve the configured extraction mode and do not add retries, periodic reconciliation, or a durable change feed.

Live verification confirmed that Notes GUI edits and Calendar/Reminders writes through EventKit in a separate process reach SQLite through `Pipeline.watch()`: creation, updates, and removal were checked. Notes in **Recently Deleted** remain exported until permanently deleted. Native observer delivery and temporary-filesystem notifications are also tested. See [watching behavior and verification limits](docs/reference.md#watching-for-changes).

## Markdown exports

Using the `source` from the quick start, create a separate pipeline with a Markdown destination:

```ts
import { MarkdownDestination } from 'elt';

const markdown = new MarkdownDestination({ path: './outputs/markdown' });

await new Pipeline({
  source,
  destination: markdown,
  steps: [
    new Copy(source.notes, markdown.folder('notes', { title: 'name' })),
  ],
}).run();
```

`folder()` creates one document per record. Use `markdown.file('notes.md', { title: 'name' })` for one combined document. Both support incremental deduplication with the same copy options and a separate checkpoint store.

Generated Markdown retains canonical record data for subsequent appends and reconciliation. Treat these files as managed output: manual edits are replaced. See [Markdown storage and recovery](docs/reference.md#markdown-destination).

## Attachment text and bytes

Using the `source` and `destination` from the quick start, load Notes attachment metadata, parsed text, and original bytes together:

```ts
import { MacOSDocumentParser } from './index.ts';

const attachments = new Copy(
  source.attachments,
  destination.table('attachments', columns => [
    columns.text('id'),
    columns.text('containerId'),
    columns.text('content')
      .from(source.attachments.file)
      .parse(new MacOSDocumentParser()),
    columns.blob('bytes').from(source.attachments.file),
  ]),
);

await new Pipeline({ source, destination, steps: [attachments] }).run();
```

Parsing is explicit. Omitting file-derived columns loads metadata only. The macOS parser supports PDFs with a text layer, TXT, Markdown, RTF, HTML, DOC, DOCX, ODT, and WordML. It does not perform OCR. Unsupported formats and actual export/parse failures fail the copy; attachments without an exportable native file retain metadata with `null` content and bytes.

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

Several copies may load one target only when all use `append_dedup` on the same `primaryKey` over disjoint partitions; an `overwrite` or `append` copy must be the target's only writer. A copy that would break that fails before it extracts anything, and dropping the target releases it. See [shared targets](docs/reference.md#shared-targets).

### Restated data

A deduplicating load resolves a key conflict with `dedupPolicy`:

| `dedupPolicy` | Behavior |
| --- | --- |
| `cursor_newer` (default) | Keep the row whose cursor sorts highest. Rejects out-of-order replay. |
| `replace` | Let the newest extraction win. Required when an upstream restates facts it already published. |

A cursor that is itself part of the primary key is equal on every conflict, so `cursor_newer` could never update the conflicting row and a restatement would load as a silent no-op. Selecting that combination is rejected; choose `replace` instead. Google Search Console is the worked example: it revises recent metrics, and its rows are identified by the same `date` it is ordered by.

## Failure behavior

- Copies execute in order. Each SQLite copy uses a transaction; Markdown stages output before publication. Failures before commit/publication preserve that copy's previous output. Earlier successful copies remain committed.
- Checkpoints are saved after loading. Data and state commits are separate, so delivery is **at least once**: retries can replay records. Deduplication reconciles replayed versions.
- `PipelineError` identifies the failed copy and earlier successful results. `CommittedWriteError` distinguishes failures after data was committed; an error does not always imply rollback.
- There is no pipeline-wide transaction, consistent snapshot across streams, automatic schema migration, or resumable full refresh.

See [execution and error handling](docs/reference.md#execution-and-failures).

## Permissions

Permissions apply to the process running the export, and a sandbox can still restrict access after permission is granted.

| Operation | Required access |
| --- | --- |
| Read Apple Notes | Notes open; Automation access to Notes |
| Watch Apple Notes | Access to its protected storage directory; may require Full Disk Access |
| Read or watch Reminders | Full Reminders access through EventKit |
| Read or watch Calendar | Full Calendar access through EventKit |
| Read Calendar `calendars`, `eventMetadata`, or `excludedDates` | Additional Automation access to Calendar |

Manage permissions in **System Settings → Privacy & Security**. Calendar and Reminders request access on the first native operation if it is undecided. Packaged hosts must provide the relevant usage descriptions and sandbox entitlements; see the [connector reference](docs/reference.md#apple-reminders).

## Development

```text
packages/elt/          Core contracts, pipelines, destinations, and checkpoint storage
packages/google-auth/  Google OAuth grants, consent, refresh, and grant storage
apps/apple/            Apple connectors, native bridges, document parser, and example app
apps/google/           Google connectors and example app
docs/                  Detailed behavior and native API research
```

Run checks from the repository root:

```sh
npx nx run-many -t typecheck
npx nx run-many -t test
```

Typecheck targets also format and lint. Test targets build first and use Node's test runner. Apple tests require macOS and an environment that permits native filesystem notifications; they use temporary files and unsaved/process-local EventKit objects, without modifying personal app data.

Run the Search Console example with `GOOGLE_OAUTH_CLIENT_ID=… GOOGLE_OAUTH_CLIENT_SECRET=… npx nx run google:start -- sc-domain:example.com sc-domain:example.org`, listing one or more properties. The first run opens a browser for Google consent; see [Search Console authorization](docs/reference.md#authorization) for the one-time OAuth client setup.

Build with `npx nx run apple:build` before running Apple scripts. Nx builds the `elt` dependency first. Run the generated JavaScript: Node's default TypeScript stripping does not support the parameter properties used here.

To add a connector, follow the [source-authoring guide](SKILL.md). Implement discovery, validation, extraction, and change watching on `Source`; keep `Stream` as immutable metadata and reuse the pipeline's loading and checkpoint handling.

## Documentation

- [API and behavior reference](docs/reference.md): schemas, keys, cursors, checkpoints, attachments, storage guarantees, and complete connector details.
- [EventKit Reminders notes](docs/eventkit-reminders.md): native API findings and implementation decisions.
- [Source-authoring guide](SKILL.md): repository conventions for implementing connectors.
