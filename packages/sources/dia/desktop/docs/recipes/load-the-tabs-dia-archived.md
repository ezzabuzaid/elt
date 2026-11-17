# Recipe: Load the tabs that Dia archived

**Use case.** You want to query the tabs that Dia archived on this Mac with SQL. You also want to sync again later, and write only the tabs that changed.

**What you need.** Dia on this Mac, and a `DiaDesktopSource` in a pipeline with a SQLite destination and a checkpoint store. The source needs no Full Disk Access.

## What the program does

1. **The first pass loads each archived tab.** It writes one row for each tab of each profile.
2. **The second pass writes nothing.** The archive did not change, so the snapshot diff finds no new or changed tab.
3. **The program counts the tabs.** It shows the count of each profile and variant, and the oldest archive date. It does not show titles or URLs.

## The program

```ts title="load-the-tabs-dia-archived.ts"
import { homedir } from 'node:os';
import { join } from 'node:path';

import { TemporaryFiles } from '@zukhruf/fs';
import { open } from '@zukhruf/sqlite-open';

import { Connection, Copy, Pipeline } from '@eltjs/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@eltjs/elt-sqlite';
import { DiaDesktopSource } from '@eltjs/source-dia-desktop/dia-desktop-source';

await using folder = await new TemporaryFiles().directory('dia-');
const path = join(folder.path, 'dia.sqlite');
const source = new DiaDesktopSource({ home: homedir() });
const destination = new SQLiteDestination({ path });
const pipeline = new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'dia',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: join(folder.path, 'checkpoints.sqlite'),
      }),
      steps: [
        new Copy(source.archivedTabs, destination.table('archivedTabs'), {
          id: 'archivedTabs',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        }),
      ],
    }),
  ],
  clock: globalThis,
});

for (const pass of ['first', 'second']) {
  const [result] = await pipeline.run();
  console.log(
    `${pass} pass: ${result?.count} written, ${result?.deleted} deleted`,
  );
}

const database = open(path, { readOnly: true });
console.table(
  database
    .prepare(
      'SELECT profileId, kind, count(*) AS tabs, min(archivedAt) AS oldest FROM archivedTabs GROUP BY profileId, kind ORDER BY profileId, kind',
    )
    .all(),
);
database.close();
```

## The output

Run it with `node load-the-tabs-dia-archived.ts`. On 2026-11-17, with Dia 1.57.1, the output was:

```text
first pass: 2477 written, 0 deleted
second pass: 0 written, 0 deleted
┌─────────┬─────────────┬──────────────┬──────┬───────────────────────────────┐
│ (index) │ profileId   │ kind         │ tabs │ oldest                        │
├─────────┼─────────────┼──────────────┼──────┼───────────────────────────────┤
│ 0       │ 'Default'   │ 'supertab'   │ 7    │ '2026-09-18T20:47:54.106568Z' │
│ 1       │ 'Default'   │ 'webContent' │ 2275 │ '2026-09-18T06:31:27.124907Z' │
│ 2       │ 'Profile 1' │ 'webContent' │ 50   │ '2026-09-28T13:55:07.675528Z' │
│ 3       │ 'Profile 4' │ 'webContent' │ 13   │ '2026-09-28T08:09:40.498839Z' │
│ 4       │ 'Profile 5' │ 'supertab'   │ 1    │ '2026-10-28T19:26:16.598681Z' │
│ 5       │ 'Profile 5' │ 'webContent' │ 72   │ '2026-09-28T13:55:07.456100Z' │
│ 6       │ 'Profile 6' │ 'webContent' │ 59   │ '2026-09-21T12:44:20.006782Z' │
└─────────┴─────────────┴──────────────┴──────┴───────────────────────────────┘
```

The archive held tabs from about the last 60 days. Dia removes older tabs from its archive. A later pass keeps their rows ([ADR 0001](../adr/0001-an-archived-tab-stays-after-dia-removes-it.md)).
