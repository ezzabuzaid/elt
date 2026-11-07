# @workspace/source-arc-desktop

An ELT source for the sidebar of the Arc browser: the spaces, and the tabs, folders, notes and split views in each space and in the favorites of each profile. It reads the sidebar file on this Mac. It does not write, it does not start Arc, and it does not use the network. It needs no Full Disk Access.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md). The decisions are in [docs/adr](./docs/adr), and the use cases are in [docs/recipes](./docs/recipes).

```ts
import { homedir } from 'node:os';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { ArcDesktopSource } from '@workspace/source-arc-desktop/arc-desktop-source';

const source = new ArcDesktopSource({ home: homedir() });
const destination = new SQLiteDestination({ path: './arc.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'arc',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({ path: './arc-state.sqlite' }),
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
}).run();
```

The constructor takes `home`, the home folder that holds the sidebar file, and an optional `scope` (`ImportScope` from `@workspace/source-apple-macos/import-scope`). `Pipeline.watch()` watches the source. The identity is `arc-desktop`.

## The file and the SDK

`@workspace/sdk-arc-desktop` reads `Library/Application Support/Arc/StorableSidebar.json` in the home folder. Arc keeps dated copies beside it (`StorableSidebar.<date>.json`). They are backups, and the SDK does not read them.

The SDK owns the location, the decoding of the file into typed spaces and items, the errors and the change signal. The source owns the streams, the scope and the snapshot comparison.

- A missing file, or a file that the process cannot read, gives `ArcSidebarUnavailableError`. The source lists it in `configErrors`, so a host sees a configuration failure.
- A file that is not the JSON that Arc writes gives `ArcSidebarFormatError`. The message names the part that is wrong, for example `the item <id> is of the kind easel, which is unknown`.
- `ArcSidebar.version()` gives the change signal, which the source gives to the pipeline. `ArcSidebar.lastWrite()` gives the time of its last write.

## Streams

Both streams are snapshot streams with the primary key `id`.

| Stream         | One row for                                                                        |
| -------------- | ---------------------------------------------------------------------------------- |
| `spaces`       | Each space, in sidebar order, with its profile, its emoji and its theme as JSON.   |
| `sidebarItems` | Each tab, folder, note and split view, with its section, its parent and its place. |

- `profileId` is the folder of the Chromium profile, for example `Default` or `Profile 2`. `source-chromium-browser` uses the same IDs for Arc's history and bookmarks.
- `section` is `pinned`, `unpinned` or `favorites`. A favorite has `spaceId` null. See [ADR 0001](./docs/adr/0001-an-item-finds-its-space-through-its-section.md).
- `parentId` is the folder or split view that holds the item. It is null at the top of a section. `position` is the place among the children of the parent, from 0.
- The fields of one kind are null for the other kinds: `url`, `savedTitle`, `muteStatus`, `referrerId` and `openerId` for a tab, `documentId` and `editable` for a note, `layoutOrientation`, `focusItemId` and `customInfo` for a split view. `lastActiveAt` is for tabs, notes and split views.
- `widthFactor` is the share of its split view that a tab takes. Arc keeps a share for some tabs only.
- Arc writes dates as seconds since 2001-01-01. The source gives them in UTC, to the microsecond.

## Scope

`scope.collectionIds` selects profiles. A space is in the import when its profile is selected. An item is in the import when the profile of its section is selected. Dates do not narrow the sidebar, because the sidebar is its state now, not a list of events.

## Sync

The sidebar file is the whole sidebar now. Thus each pass reads it one time and compares it with the last snapshot under `ClosedWorld`. A removed item or space is deleted, and a rerun with no change writes nothing. See [ADR 0002](./docs/adr/0002-the-sidebar-file-is-the-whole-sidebar.md).

- A pass holds the whole file in memory: about 2 MB for 900 items.
- A watch reads the file stamp each second. A write of the file wakes both streams.
- `currentAsOf` is the last write of the file. Arc writes the file only while it runs, and it syncs the sidebar with other devices only then.

## Live checks

On 2026-11-02, on macOS 27, the live test read the sidebar file of this Mac (Arc not used since 2025-08, the file last written on 2026-01-01): 9 spaces and 881 items (765 tabs, 101 folders, 14 notes, 1 split view) in two profiles. A rerun wrote nothing. One tab had no saved page title, and 11 tabs had no last use. These are null.

Not verified: an edit in Arc while the watch runs, because Arc was not in use. The tests write the file as Arc writes it.
