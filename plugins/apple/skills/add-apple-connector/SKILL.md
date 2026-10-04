---
name: add-apple-connector
description: Adds an Apple app the Apple plugin does not import yet, such as Photos, Music, Podcasts or Stickies, by writing a connector into the user's connectors folder. Use when the user asks to connect or import a Mac app the plugin does not list, or to fix a connector the Apple status reports as not loading.
---

# Add an Apple connector

## What you need to know

- A connector is a folder in `~/Library/Application Support/Context Compiler/Connectors/<name>/` holding two files: a `package.json` and the entry point it names. The plugin reads that folder on every tool call, so a connector you add or edit is used in this chat; nothing restarts.
- `package.json` is `{ "type": "module", "exports": "./<name>-app.ts", "contextCompiler": { "name": "<name>", "title": "<Title>" } }`. `name` is lowercase letters, digits and dashes, must equal the app class's `name`, and must not repeat an app the plugin already has. `title` is what the user sees.
- The entry is TypeScript that Node runs as written, without a compiler. Its default export is a class that extends `AppleApp`. Its `source()` returns an elt `Source` that reads the app's own data on this Mac.
- The entry may import only Node built-ins (`node:fs`, `node:sqlite`, `node:child_process`, ...) and three modules the plugin provides: `@workspace/elt` (`Source`, `Stream`, `Catalog` and their types), `@workspace/connector-apple-app/apple-app` (`AppleApp`) and `@workspace/connector-apple-app/choice` (`accounts`, `collections`, `byId`, `name`, `Choice`). There is no `node_modules`, so no npm package resolves.
- The plugin imports each stream into `raw_<stream>` in the app's own `data.sqlite`, read through a view named after the stream in snake case (`photoAssets` reads as `photo_assets`). `$query-apple` reads it like any other app.
- The connector runs inside the plugin, with every macOS permission ChatGPT has, Full Disk Access included.
- A connector that cannot load is listed in the Apple status of every chat as `- <Title> could not be loaded: <error>`.

## Writing the connector

1. Find where the app keeps its data and how to read it read-only: a SQLite store (open it with `node:sqlite` and `{ readOnly: true }`), property lists (`plutil -convert json -o - <file>`), or the app's scripting (`osascript`). Inspect real rows before writing a schema.
2. Write `package.json` and `<name>-app.ts` from this template. Keep the connector in that one file.

   ```ts
   import { homedir } from 'node:os';
   import { join } from 'node:path';
   import { DatabaseSync } from 'node:sqlite';

   import { AppleApp } from '@workspace/connector-apple-app/apple-app';
   import type { Choice } from '@workspace/connector-apple-app/choice';
   import {
     Catalog,
     type ExtractionCoverage,
     Source,
     type SourceWatchOptions,
     Stream,
   } from '@workspace/elt';

   const items = new Stream({
     name: 'items',
     jsonSchema: {
       type: 'object',
       description: 'One item in the app.',
       properties: {
         id: { type: 'string', description: 'The item identifier.' },
         title: { type: ['string', 'null'], description: 'The item title.' },
       },
     },
     primaryKey: ['id'],
     sourceDefinedCursor: true,
     supportedSyncModes: ['full_refresh', 'incremental'],
   });

   class ItemsSource extends Source {
     readonly identity = 'example';
     protected readonly catalog = new Catalog([items]);

     coverage(): ExtractionCoverage {
       return { description: 'every item in the app', selection: {} };
     }

     protected async open() {
       return new AsyncDisposableStack();
     }

     // Yields the streams once; yield them again whenever the store changes.
     protected async *observe({ streams }: SourceWatchOptions) {
       yield streams;
     }

     protected async *extract() {
       using database = new DatabaseSync(
         join(homedir(), 'Library/<where the app keeps its store>'),
         { readOnly: true },
       );
       for (const row of database.prepare('SELECT id, title FROM items').all())
         yield {
           stream: 'items',
           data: { id: String(row.id), title: row.title },
         };
       yield { type: 'STATE' as const, stream: 'items', state: {} };
     }
   }

   export default class ExampleApp extends AppleApp {
     readonly name = 'example';
     readonly title = 'Example';
     // What a date range selects, such as 'date added', or null.
     readonly datedBy = null;
     // true only when macOS keeps the store behind Full Disk Access, as for
     // ~/Library/Containers, Group Containers, Mail, Messages and Safari.
     readonly fullDiskAccess = false;
     protected readonly choices: readonly Choice[] = [];
     // With nothing to choose, the stream apple_options reads to show the
     // store opens.
     protected override readonly probe = 'items';
     protected readonly unscoped = [];
     protected readonly storeCopies = [];

     // What the user does besides Full Disk Access, or ''.
     protected access(): string {
       return 'Open Example once so it creates its library.';
     }

     protected source(): Source {
       return new ItemsSource();
     }
   }
   ```

3. Let the user narrow the import only when the store can say which account, collection or date a record belongs to. Then list those streams in `choices` (built with `accounts` and `collections`), set `datedBy`, pass the `scope` that `source(scope)` receives into the source, and filter by its `accountIds`, `collectionIds`, `startAt` (inclusive) and `endAt` (exclusive). List streams whose rows belong to no account or collection in `unscoped`. When there are choices, remove `probe`: reading them shows the store opens.

## Setting it up

1. Call `apple_options` with the connector's `name`. It loads the connector and opens the app's store. Read any `could not be loaded` line in the Apple status or the tool's error, fix the file, and call it again.
2. Configure it with `apple_configure`, keeping every app already selected, as `$setup-apple` describes. The import runs in the background.
3. Read a few rows as `$query-apple` describes, and compare them with what the app shows.

## Gotchas

- When the entry uses an `enum`, a `namespace` or a constructor parameter property such as `constructor(private store: string)`, Node cannot run it as written and the connector does not load. Declare fields and assign them in the constructor.
- When a stream or one of its fields has no `description`, the import fails with `Reader view <stream> needs JSON Schema descriptions`. Describe every stream and every property.
- When a record's fields do not match its stream's JSON Schema, such as a `null` where the schema says `string`, the pass fails. Allow `null` (`type: ['string', 'null']`) for any column that can be empty.
- When a connector imports a second file of its own, an edit to that file loads only in a new chat. Keep the connector in its entry.
- When the code writes to the app's store or runs a command that changes the app, it changes the user's data with ChatGPT's permissions. Open stores read-only and only read.
- When `name` repeats an app the plugin has, or differs from the class's `name`, the connector is reported as not loading. Pick a new lowercase name and use it in both places.

## Done when

- `apple_options` with the connector's name succeeds, and the Apple status lists no `could not be loaded` line for it.
- The app is configured, its import has synced, and rows read through `$query-apple` match the app.
- You told the user the connector's folder, what it imports and that it runs with ChatGPT's permissions on their Mac.
