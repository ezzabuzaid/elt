# Load the sidebar and count it by profile and section

A user wants to know what Arc's sidebar holds before an agent reads it: how many tabs, folders and notes each profile has, pinned, unpinned and in favorites. This program loads the sidebar file of this Mac into a SQLite file in a temporary folder, runs a second pass to show that a pass with no change writes nothing, and counts the items. It prints no URL and no title.

```ts
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { ArcDesktopSource } from '@workspace/source-arc-desktop/arc-desktop-source';

const directory = await mkdtemp(join(tmpdir(), 'arc-'));
const source = new ArcDesktopSource({ home: homedir() });
const destination = new SQLiteDestination({
  path: join(directory, 'arc.sqlite'),
});
const pipeline = new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'arc',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: join(directory, 'arc-state.sqlite'),
      }),
      steps: [source.spaces, source.sidebarItems].map(
        (stream) =>
          new Copy(stream, destination.table(stream.name), {
            id: stream.name,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
      ),
    }),
  ],
});

for (const pass of ['first', 'second'])
  for (const { copy, count, deleted } of await pipeline.run())
    console.log(pass, copy.from.name, { count, deleted });

using database = new DatabaseSync(join(directory, 'arc.sqlite'), {
  readOnly: true,
});
console.table(
  database
    .prepare(
      `SELECT profileId, section, kind, count(*) AS items
       FROM sidebarItems GROUP BY profileId, section, kind
       ORDER BY profileId, section, kind`,
    )
    .all(),
);
```

Output on 2026-11-02, on this Mac:

```text
first spaces { count: 9, deleted: 0 }
first sidebarItems { count: 881, deleted: 0 }
second spaces { count: 0, deleted: 0 }
second sidebarItems { count: 0, deleted: 0 }
┌─────────┬─────────────┬─────────────┬─────────────┬───────┐
│ (index) │ profileId   │ section     │ kind        │ items │
├─────────┼─────────────┼─────────────┼─────────────┼───────┤
│ 0       │ 'Default'   │ 'favorites' │ 'tab'       │ 4     │
│ 1       │ 'Default'   │ 'pinned'    │ 'folder'    │ 101   │
│ 2       │ 'Default'   │ 'pinned'    │ 'note'      │ 14    │
│ 3       │ 'Default'   │ 'pinned'    │ 'splitView' │ 1     │
│ 4       │ 'Default'   │ 'pinned'    │ 'tab'       │ 728   │
│ 5       │ 'Default'   │ 'unpinned'  │ 'tab'       │ 31    │
│ 6       │ 'Profile 2' │ 'favorites' │ 'tab'       │ 2     │
└─────────┴─────────────┴─────────────┴─────────────┴───────┘
```

- `Profile 2` has favorites and no space. Its favorites have `spaceId` null.
- The second pass writes nothing, because the sidebar file did not change.
- The temporary folder holds a copy of the sidebar. Delete it when you are done.
