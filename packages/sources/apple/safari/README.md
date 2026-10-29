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

A Context Compiler import loads every stream incrementally into its `data.sqlite`, and readers query it through its `<snake_stream>` views. The import stores a download that is still on disk in its `files` folder and refers to it by `attachmentRef`.

## Stores

| Store                                       | Where                                                                                                     | Streams                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `History.db` (SQLite), one for each profile | `~/Library/Safari` for the default profile; `Profiles/<serverId>` in the container for each other profile | `historyItems`, `historyVisits`, `historyTombstones`, `historyTags`, `historyItemTags`                                           |
| `SafariTabs.db` (SQLite)                    | `~/Library/Containers/com.apple.Safari/Data/Library/Safari`                                               | `profiles`, `profileStartPageSections`, `windows`, `windowProfiles`, `windowTabGroups`, `tabGroups`, `tabs`, `tabHistoryEntries` |
| `CloudTabs.db` (SQLite)                     | the container                                                                                             | `cloudTabDevices`, `cloudTabs`, `cloudTabPositions`, `cloudTabCloseRequests`                                                     |
| `Bookmarks.plist`                           | `~/Library/Safari`                                                                                        | `bookmarks`, `readingListItems`                                                                                                  |
| `RecentlyClosedTabs.plist`                  | `~/Library/Safari`                                                                                        | `closedWindows`, `closedTabs`, `closedWindowActiveTabs`                                                                          |
| `Downloads.plist`                           | `~/Library/Safari`                                                                                        | `downloads`                                                                                                                      |

A run opens only the stores that its streams read. It reads each database in one read transaction, and each property list one time. The stores are separate files, so the streams of different stores do not come from one moment. A store that the source cannot open fails only its own streams.

All streams are [snapshot streams](../../../elt/README.md#snapshot-streams). Use full refresh, or `incremental` with `append_dedup` on the key of the stream and no `cursorField`.

## Access

Each store is in a folder that macOS guards with [Full Disk Access](../messages/README.md#full-disk-access). Give Full Disk Access to the process that runs the pipeline. Safari has no public API, and its AppleScript dictionary gets only the open windows and tabs.

A store that is missing or that the process cannot read fails only its own streams, with `SafariUnavailableError`, which names Full Disk Access. A database that does not have a column that the reader uses fails with `MissingColumnsError`, which names the columns. A failure never reads as an empty store, because that would delete every row.

## Profiles

Safari 17 and later keep profiles in `SafariTabs.db`. The `id` of a profile is its `external_uuid`, and each `profileId` refers to it. The profile that Safari starts with is `DefaultProfile`, and it has no stored title. Safari shows it as Personal when other profiles exist. The `serverId` of a profile names the folder of its data. The history of the default profile is `~/Library/Safari/History.db`. The history of another profile is `Profiles/<serverId>/History.db` in the container.

History IDs are local to the database of one profile. The history streams use `(profileId, id)` as key, so a join between them must also match `profileId`.

A tab or tab group belongs to the nearest profile folder above it. A group under the root folder belongs to the default profile. The groups of a window belong to the profile of the window. When Safari recorded a profile in the page context of a tab, that context names the profile. The pinned-tab folders belong to no profile.

## Streams

| Stream                                                                       | Contents                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `historyItems`                                                               | One URL for each profile: visit count, ranking score, the ranking values of Safari for each day and each week (weighted values, not counts; `bigint[]`), autocomplete triggers (`text[]`), last HTTP status.                                                                                                                                        |
| `historyVisits`                                                              | Each visit: `itemId`, time, title, load success, non-GET, synthesized, redirect source and destination visits, `origin` (0 this Mac, 1 another device through iCloud), sync generation, attribute mask, score.                                                                                                                                      |
| `historyTombstones`                                                          | The deletions that Safari keeps to sync: a cleared range (a start without a limit reads NULL) and the removed URL, plain in `url` or encrypted in `encryptedUrl` (base64), as Safari 27 keeps it.                                                                                                                                                   |
| `historyTags`, `historyItemTags`                                             | The topics that Safari found in the history (Wikidata item identifiers), and the items that have them.                                                                                                                                                                                                                                              |
| `profiles`, `profileStartPageSections`                                       | Profiles with symbol, named color and components, own Favorites folder (`favoritesFolderServerId` → `bookmarks.serverId`), and the Start Page sections that a profile changed.                                                                                                                                                                      |
| `windows`, `windowProfiles`, `windowTabGroups`                               | Saved windows with their profile, active, local and private groups, and window state (private, popup, minimized, selected tab, bars, sidebar, frame, address text not submitted); the profiles that each window keeps; the groups that a window holds or shows, with the active tab of each group.                                                  |
| `tabGroups`                                                                  | Each tab folder with its `kind`: `named`, `unnamed` (synced groups of the ordinary tabs of a profile), `local` and `private` (the own groups of a window), `pinned`, `privatePinned`, `recentlyClosed`, `favorites` (the own Favorites of a group), `device` (the unnamed groups of one device), `special`.                                         |
| `tabs`, `tabHistoryEntries`                                                  | Open tabs, pinned tabs (with the address that they go back to) and group Favorites; synced and local titles and URLs, times, reader state, opener chain, page language, keywords with weights (`text[]`, `double precision[]`); the back and forward list of each tab, oldest first, with the entry that the tab shows.                             |
| `cloudTabDevices`, `cloudTabs`, `cloudTabPositions`, `cloudTabCloseRequests` | iCloud Tabs as Safari last got them: devices (name, model), their tabs, the ordering values of each tab (a zlib-compressed JSON list), and requests to close a tab on another device that are not done yet.                                                                                                                                         |
| `bookmarks`, `readingListItems`                                              | The bookmark tree (folders, bookmarks, proxies such as History; titles, descriptions that a person typed or that Safari got, iCloud `serverId`) with the Reading List folder, and Reading List items (added, viewed, preview, image, offline fetch, added on this Mac).                                                                             |
| `closedWindows`, `closedTabs`, `closedWindowActiveTabs`                      | History › Recently Closed: windows with their state, tabs closed alone or with their window, and the active tab of each closed window for each group.                                                                                                                                                                                               |
| `downloads`                                                                  | The Downloads list: URL, saved path, profile, times, bytes, and the file when it is still at `path` (`availableLocally`). For an archive that Safari opened itself, `path` names the archive in a `.download` folder that no longer exists, and `openedPath` names the first extracted file. The extracted files move next to it, so no file loads. |

The source does not read:

- the iCloud sync bookkeeping: `history_events`, `history_event_listeners`, `history_client_versions`, `metadata`, `generations`, the `sync_*` tables, CloudKit `system_fields` and `Sync.Data`;
- derived indexes: `bookmark_title_words` and `folder_ancestors`;
- WebKit and AppKit state: the form and scroll state in `SessionHistoryEntryData`, `WindowRestorationArchiveData` and `restoration_archive`;
- icon caches, AutoFill, form values and passwords, per-site preferences and permissions, and extensions.

## Scope

`new AppleSafariSource({ scope })` narrows the import. `collectionIds` names profiles. It selects history, profiles, windows, tab groups, tabs, recently closed windows and tabs, and downloads. Folders of no profile, such as the pinned-tab folders, load under the scope of any profile. `startAt` (inclusive) and `endAt` (exclusive) select history visits, and the history items, tag links and tags that these visits reach. Tombstones and all other streams load whole. Bookmarks, the Reading List and iCloud Tabs belong to no profile and load whole. The Context Compiler plugin leaves them out of a scoped import. If you omit a key, the source reads all.

## Changes and deletions

Each stream compares a full read of its store with the previous read. The change records of Safari cannot replace this, because Safari removes visits that are older than its history setting and writes no tombstone for them. When Safari started on 2026-09-30, it removed each visit that was older than a year (the oldest visit moved from 2025-08-21 to 2025-09-30), and it wrote no tombstone.

Thus `historyVisits` and `historyItems` expire by `visitedAt` and by `lastVisitedAt`, the time of the latest visit of a URL ([ADR 0001](./docs/adr/0001-history-expires-by-the-history-setting-of-safari.md)). A visit or URL that disappeared before the horizon of Safari keeps its row. A visit or URL that was removed after the horizon is deleted.

- The horizon is the start of the read less `HistoryAgeInDaysLimit` days, plus one hour for a daylight saving change.
- That key holds the day count of General › Remove history items. Its menu stores 1, 7, 14, 30 or 365, and Manually stores 365000.
- While the key is not set, Safari keeps a year. Safari reads a value below 1 as one day.
- Safari also keeps no more than 100,000 URLs. Its daily maintenance drops the URLs with the oldest last visit. Past that limit, the rows of dropped URLs and visits after the horizon would be deleted (#2247). The probed Mac had 8,300.
- Tags and tombstones do not expire with the history setting (the tags of the probed Mac date from 2025-03). Their rows are deleted when they disappear.

A watch reads the `data_version` of each database, also of a `History.db` of a profile that is made during the watch. It also reads the inode, size and modification time of each property list. It does this each second, and it wakes only the streams of the store that changed. A watch never starts Safari. History from other devices and iCloud Tabs arrive only while Safari runs.

## How current the streams are

Only Safari syncs its history and iCloud Tabs. Thus, for the history and iCloud Tabs streams, `currentAsOf` is the last write of that store (the `History.db` of each profile, or `CloudTabs.db`) while Safari is closed, and `null` while Safari runs. The tab groups and bookmarks sync through helpers that run without Safari, so they and the other streams answer `null`. See [how current a stream is](../../../elt/README.md#how-current-a-stream-is).

## Limitations

- Safari removes visits that are older than its history setting, and keeps no record of this. The source keeps the rows of visits and items that Safari expired this way. A visit or item that the user removes within the history setting is deleted.
- Other stores show their state now. A run deletes the rows that disappeared from them.
- Stores are separate files, so the streams of different stores do not come from one moment.
- History from other devices and iCloud Tabs arrive only while Safari runs. A watch does not start Safari.
- The source does not read sync bookkeeping, icon caches, AutoFill, form values, passwords, site settings or extensions.

## Live checks

The live check ran on 2026-09-30 on macOS 27.0 (26A428) and Safari 27.0. It used Safari to make probe objects, then removed each probe object, and a new load showed each removal:

- `origin`: a visit on this Mac stayed 0 after Safari uploaded it (sync generation 1635). 736 visits that synced from an iPhone arrived as 1. When Safari started after five weeks, it got only the last two weeks of the history of the iPhone.
- A second profile wrote its visit to `Profiles/<serverId>/History.db`, not to the default `History.db`. Its tabs named the profile by `external_uuid`. The deletion of the profile removed its folder, rows and Favorites folder. (When it is the last extra profile, Safari asks to "stop using Profiles".) The next load deleted its history, tabs and groups.
- The deletion of a history item wrote a tombstone with a start without a limit and an encrypted URL of 208 bytes. Each of six deletions wrote one tombstone, and the next load deleted the visits and items. History › Clear History for the last hour wrote one tombstone with that hour as its range and no URL.
- A bookmark saved with a description kept it as `previewText` with `previewTextIsUserDefined`. New Reading List items got to `Bookmarks.plist` only some minutes later, at the next write of Safari. The removal of these items and of the bookmark deleted their rows.
- A pinned tab moved under the `pinned` folder. A new named tab group was under the root folder, with its own `TopScopedBookmarkList` Favorites.
- A plain download recorded its final path. An archive that Safari opened itself recorded paths in a `.download` folder that Safari removed. When the Downloads list was cleared, `Downloads.plist` became empty and the rows were deleted.
- Safari keeps the windows and tabs of the previous session in `SafariTabs.db` until the next session replaces them.
- A second load with no changes, while Safari ran, wrote nothing.
- On 2026-10-01, this Mac closed an iPhone tab from its iCloud Tabs. Safari wrote one close request that names the iPhone as its device, with the URL and id of the tab. The next load added it. It stayed until Safari ran on the iPhone, which removed the request and the tab. The next load deleted both rows.

Unverified: shared tab groups, because they need a second iCloud account (#2117).

## Decisions

- [ADR 0001](./docs/adr/0001-history-expires-by-the-history-setting-of-safari.md): history expires by the history setting of Safari.
