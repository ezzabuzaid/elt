# @workspace/source-apple-safari

An ELT source for Safari. It reads the local stores of Safari in `~/Library/Safari` and in the Safari container (history, tabs, iCloud Tabs, bookmarks, the Reading List, recently closed tabs and downloads) in read-only mode through `@workspace/sdk-apple-safari`. It does not use the network, and Safari does not have to be open.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { AppleSafariSource } from '@workspace/source-apple-safari/apple-safari-source';

const source = new AppleSafariSource();
const destination = new SQLiteDestination({ path: './outputs/safari.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'apple-safari',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './outputs/safari-state.sqlite',
      }),
      steps: [
        source.historyItems,
        source.historyVisits,
        source.tabs,
        source.bookmarks,
      ].map(
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

`downloads` can give the downloaded file while it is still at its path. To store it and read its text, declare a stored-file column and a `ComputedDataset` with the `DocumentText` rule, as the [Notes README](../notes/README.md) shows.

## Streams

| Store                              | Streams                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `History.db`, one for each profile | `historyItems`, `historyVisits`, `historyTombstones`, `historyTags`, `historyItemTags`                                           |
| `SafariTabs.db`                    | `profiles`, `profileStartPageSections`, `windows`, `windowProfiles`, `windowTabGroups`, `tabGroups`, `tabs`, `tabHistoryEntries` |
| `CloudTabs.db`                     | `cloudTabDevices`, `cloudTabs`, `cloudTabPositions`, `cloudTabCloseRequests`                                                     |
| `Bookmarks.plist`                  | `bookmarks`, `readingListItems`                                                                                                  |
| `RecentlyClosedTabs.plist`         | `closedWindows`, `closedTabs`, `closedWindowActiveTabs`                                                                          |
| `Downloads.plist`                  | `downloads`                                                                                                                      |

History IDs are local to the database of one profile. The history streams use `(profileId, id)` as key, so a join between them must also match `profileId`.

All streams are snapshot streams. Use full refresh, or `incremental` with `append_dedup` and no `cursorField`. A run opens only the stores that its streams read.

## Access

Give **Full Disk Access** to the process that runs the pipeline. A store that is missing or that the process cannot read fails only its own streams, with `SafariUnavailableError`. A database that does not have a column that the reader uses fails with `SafariSchemaError`, which names the columns. A failure never reads as an empty store.

## Scope

`new AppleSafariSource({ scope })` narrows the import. `collectionIds` selects profiles. `startAt` (inclusive) and `endAt` (exclusive) select history visits, and the history items and tags that these visits reach. Bookmarks, the Reading List and iCloud Tabs belong to no profile and load whole. If you omit a key, the source reads all.

## Limitations

- Safari removes visits that are older than its history setting, and keeps no record of this. The source keeps the rows of visits and items that Safari expired this way. A visit or item that the user removes within the history setting is deleted.
- Other stores show their state now. A run deletes the rows that disappeared from them.
- Stores are separate files, so the streams of different stores do not come from one moment.
- History from other devices and iCloud Tabs arrive only while Safari runs. A watch does not launch Safari.
- The source does not read sync bookkeeping, icon caches, AutoFill, form values, passwords, site settings or extensions.

See [docs/reference.md](../../../../docs/reference.md#apple-safari) for the details.
