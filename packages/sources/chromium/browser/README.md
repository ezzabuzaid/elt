# @workspace/source-chromium-browser

An ELT source for the history, the downloads, the searches and the bookmarks of one Chromium browser on this Mac, such as Dia, Chrome, Arc or Edge. It reads the files of the browser in each profile folder. The browser does not need to run, and the source needs no Full Disk Access.

The words in this README have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

```ts
import { homedir } from 'node:os';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { dia } from '@workspace/sdk-chromium-browser';
import { ChromiumSource } from '@workspace/source-chromium-browser/chromium-source';

const source = new ChromiumSource({ browser: dia, home: homedir() });
const destination = new SQLiteDestination({ path: './dia.sqlite' });
const { streams } = await source.discover();

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'dia',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({ path: './dia-state.sqlite' }),
      steps: streams.map(
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

`@workspace/sdk-chromium-browser` exports `dia`, `chrome`, `arc`, `edge` and `brave`. The identity of the source is `chromium:<browser id>`, for example `chromium:dia`, so each browser keeps its own checkpoints.

## Streams

| Stream          | Store       | Key                               | Holds                                                                                         |
| --------------- | ----------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| `profiles`      | Local State | `id`                              | Each profile folder that holds a History or Bookmarks file, with the name from Local State    |
| `historyItems`  | History     | `profileId`, `id`                 | Each URL, with its title and visit counts                                                     |
| `historyVisits` | History     | `profileId`, `id`                 | Each visit: its time, its transition, its source, what led to it, and its context annotations |
| `downloads`     | History     | `profileId`, `id`                 | Each download in the list of the browser, with its chain of URLs                              |
| `searchTerms`   | History     | `profileId`, `keywordId`, `urlId` | Each search from the address bar, with its results page                                       |
| `bookmarks`     | Bookmarks   | `profileId`, `guid`               | Each bookmark and folder, with its root folder, its parent and its position                   |

The description of each field in the schema tells readers what the field holds. Times are UTC instants to the microsecond, as the browser keeps them. A random 64-bit task ID is `int64` text, because a JSON number cannot hold it. `transition` keeps the number that the browser stores, and `transitionType` and `transitionQualifiers` decode it. `source` keeps the number of `visit_source`: no row is 1 (browsed on this Mac), and Dia writes 6 on the visits that it imported from Arc.

## How the stores are read

- **History** is a SQLite database with a rollback journal. A running browser holds it in exclusive locking mode, so no other connection can read it. The SDK `@workspace/sdk-chromium-history` reads a checked copy at the last commit of the browser (`Snapshot.ofExclusiveOwner` of `@zukhruf/sqlite-snapshot`). A History with no tables, as in a profile that never kept history, gives no rows. A History without a column that the SDK reads fails with `MissingColumnsError`.
- **Bookmarks** is JSON that the browser replaces whole. The SDK `@workspace/sdk-chromium-bookmarks` reads it into flat nodes. A time of `"0"` is no time.
- **Local State** names the profiles. A profile folder that Local State does not list loads with a `null` name.

`open` opens only the stores that the selected streams read. A store that cannot be read fails only its streams, and their rows stay loaded. A History or a Bookmarks file that is missing or denied is a `config` failure. A file that is not in the format of the browser is a `system` failure.

## Sync and deletions

Each pass reads each selected store whole, and a snapshot diff writes only the rows that changed. A second pass with no change writes nothing.

- A browser that removes old history (Chrome, Edge, Brave) gives `historyItems`, `historyVisits` and `searchTerms` an `expiresAt` field. A row that went after its expiry stays loaded, and a row that went before it is deleted. See [ADR 0001](./docs/adr/0001-history-expires-only-for-a-browser-that-removes-it.md).
- A browser that keeps its history (Dia, Arc) has no `expiresAt`. Each row that went is deleted.
- `downloads` and `bookmarks` delete each row that went: the user removed it.

## Scope

`scope.collectionIds` holds profile folders. It selects the rows of each stream. `scope.startAt` (inclusive) and `scope.endAt` (exclusive) select visits only. A visit compares with them by its millisecond.

## Watch and currency

`observe()` checks each store each second, with `pollChanges` of `@zukhruf/async`. A commit to a History, a new Bookmarks file, a new Local State, or a profile that gets or loses one of these files wakes the streams of that store only.

While the browser is closed, the History and Bookmarks streams are current as of the last write of the browser to them. While it runs, each stream is current as of the pass. See [ADR 0002](./docs/adr/0002-a-browser-runs-while-its-singleton-lock-names-a-live-process.md).

## Live checks

On 2026-11-02, on macOS 27, with Dia running, the source loaded each installed browser, and a second pass wrote nothing:

| Browser | Profiles | URLs   | Visits  | Downloads | Searches | Bookmarks | First pass | Second pass |
| ------- | -------- | ------ | ------- | --------- | -------- | --------- | ---------- | ----------- |
| Dia     | 5        | 29,211 | 82,300  | 18        | 92       | 960       | 4.3 s      | 2.5 s       |
| Chrome  | 2        | 634    | 320     | 3         | 5        | 577       | 0.2 s      | 0.2 s       |
| Arc     | 3        | 41,047 | 108,227 | 157       | 5,193    | 0         | 7.3 s      | 3.6 s       |
| Edge    | 1        | 7      | 61      | 0         | 0        | 0         | 0.3 s      | 0.1 s       |

- History has version 70 in each of these browsers, with the same columns.
- Chrome keeps random 64-bit task IDs in `context_annotations`, past what a JavaScript number holds.
- Arc and Edge have no Bookmarks file. Dia's Default profile has a History with no tables.

## Limits

- A pass copies each selected History and reads it whole. The copy is an APFS clone, but the read grows with the History: 108,227 visits took 3.6 s.
- The source reads only what the browser keeps on this Mac. Visits of other devices come only while the browser runs and syncs.
- Dia keeps its tabs and other data in encrypted databases. This source does not read them.
