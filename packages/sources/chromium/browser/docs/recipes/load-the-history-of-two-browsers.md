# Recipe: Load the history of two browsers

**Use case.** You want the visits and the bookmarks of Dia and of Chrome in one SQLite file. You also want to sync again later, and write only the rows that changed.

**What you need.** Dia and Chrome on this Mac. Dia can run. The program uses one `ChromiumSource` for each browser, each with its own checkpoint store, and one SQLite destination. The source needs no Full Disk Access.

## What the program does

1. **The first pass loads each visit and bookmark of each profile.** Each browser writes to its own tables.
2. **The second pass writes nothing.** The snapshot diff finds no new, changed or deleted row.
3. **The program counts the visits.** It shows how many visits of each browser are older than 90 days. Chrome removes those visits, and Dia keeps them. The program does not show titles or URLs.

## The program

```ts title="load-the-history-of-two-browsers.ts"
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { open } from '@zukhruf/sqlite-open';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { chrome, dia } from '@workspace/sdk-chromium-browser';
import { ChromiumSource } from '@workspace/source-chromium-browser/chromium-source';

const directory = await mkdtemp(join(tmpdir(), 'chromium-'));
const path = join(directory, 'browsers.sqlite');
const destination = new SQLiteDestination({ path });
const connections = [dia, chrome].map((browser) => {
  const source = new ChromiumSource({ browser, home: homedir() });
  return new Connection({
    name: browser.id,
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(directory, `${browser.id}-checkpoints.sqlite`),
    }),
    steps: [source.historyVisits, source.bookmarks].map(
      (stream) =>
        new Copy(stream, destination.table(`${browser.id}_${stream.name}`), {
          id: `${browser.id}:${stream.name}`,
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        }),
    ),
  });
});
const pipeline = new Pipeline({
  history: new SQLiteSyncHistory(),
  connections,
});

for (const pass of ['first', 'second']) {
  const results = await pipeline.run();
  console.log(`${pass} pass:`);
  for (const { copy, count, deleted } of results)
    console.log(`  ${copy.id}: ${count} written, ${deleted} deleted`);
}

const database = open(path, { readOnly: true });
console.table(
  database
    .prepare(
      `SELECT 'dia' AS browser, count(*) AS visits,
         count(*) FILTER (WHERE visitedAt < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-90 days')) AS olderThan90Days
       FROM dia_historyVisits
       UNION ALL
       SELECT 'chrome', count(*),
         count(*) FILTER (WHERE visitedAt < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-90 days'))
       FROM chrome_historyVisits`,
    )
    .all(),
);
database.close();
await rm(directory, { recursive: true });
```

## The output

Run it with `node load-the-history-of-two-browsers.ts` from a folder where the `@workspace` packages resolve. On 2026-11-02, on macOS 27, with Dia running and Chrome closed, the output was:

```text
first pass:
  dia:historyVisits: 82300 written, 0 deleted
  dia:bookmarks: 960 written, 0 deleted
  chrome:historyVisits: 320 written, 0 deleted
  chrome:bookmarks: 577 written, 0 deleted
second pass:
  dia:historyVisits: 0 written, 0 deleted
  dia:bookmarks: 0 written, 0 deleted
  chrome:historyVisits: 0 written, 0 deleted
  chrome:bookmarks: 0 written, 0 deleted
┌─────────┬──────────┬────────┬─────────────────┐
│ (index) │ browser  │ visits │ olderThan90Days │
├─────────┼──────────┼────────┼─────────────────┤
│ 0       │ 'dia'    │ 82300  │ 80759           │
│ 1       │ 'chrome' │ 320    │ 0               │
└─────────┴──────────┴────────┴─────────────────┘
```

## What to know

- Dia held its History in exclusive locking mode while the program ran. The source read a checked copy of it.
- Chrome removes old history, so its `historyVisits` has `expiresAt`. A visit that Chrome removes after 90 days stays in the table. Dia's `historyVisits` has no `expiresAt`, and a visit that the user removes is deleted.
- Each browser has its own checkpoint store, because each source has its own identity (`chromium:dia`, `chromium:chrome`).
