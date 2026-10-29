# @workspace/source-apple-books

An ELT source for Apple Books: the library, collections, highlights and notes, reading state that iCloud syncs, reading history and goal, store purchases and reviews, themes, and the book files that are on this Mac. It reads the stores that Books and its sync daemon `bookdatastored` keep in Books' container and group container, through the SDK `@workspace/sdk-apple-books`. It does not use the network, and Books does not have to be open.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md), and the glossary of [elt](../../../elt/CONTEXT.md) for the words of all of elt.

```ts
import { Connection, Copy, LocalFiles, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { AppleBooksSource } from '@workspace/source-apple-books/apple-books-source';

const source = new AppleBooksSource(); // Books' container and its group container
const destination = new SQLiteDestination({ path: './outputs/books.sqlite' });
const files = new LocalFiles({ directory: './outputs/books-files' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'apple-books',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './outputs/books-state.sqlite',
      }),
      steps: [source.annotations, source.readingDays, source.bookFiles].map(
        (stream) =>
          new Copy(
            stream,
            destination.table(
              stream.name,
              stream.supportsFileTransfer
                ? (columns) => [
                    ...SQLiteColumns.fromSchema(stream.jsonSchema),
                    columns
                      .text('attachmentRef')
                      .from(stream.file.store(files)),
                  ]
                : undefined,
            ),
            {
              id: stream.name,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            },
          ),
      ),
    }),
  ],
}).run();
```

`bookFiles` supports file transfer. The example gives its copy the column `attachmentRef` from `source.bookFiles.file`, so a book whose bytes are on this Mac is stored in `./outputs/books-files`. To read other folders, give them to the constructor: `new AppleBooksSource({ container, groupContainer })`.

A Context Compiler import loads every stream incrementally into its `data.sqlite`. Readers use its `<snake_stream>` views. The import keeps each local book in its `files` folder, and `attachmentRef` refers to it.

## Stores

| Store                                                                   | Where                                                                                                      | Streams                                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `BKLibrary-1-091020131601.sqlite` (Core Data)                           | `~/Library/Containers/com.apple.iBooksX/Data/Documents/BKLibrary`                                          | `libraryAssets`, `collections`, `collectionMembers`, `bookFiles` |
| `AEAnnotation_v10312011_1727_local.sqlite` (Core Data)                  | `…/Documents/AEAnnotation` in the same container                                                           | `annotations`                                                    |
| `BCAssetData` (Core Data)                                               | `~/Library/Group Containers/group.com.apple.iBooks/Documents/BCCloudData-BookDataStoreService/BCAssetData` | `assetDetails`, `reviews`                                        |
| `CRDTModelSync-ReadingHistoryModel` (Core Data holding a CRDT document) | `…/BCCloudData-BookDataStoreService/CRDTModelSync-ReadingHistoryModel`                                     | `readingMonths`, `readingDays`, `streakRecords`                  |
| `BKJaliscoServerSource-v09182016.sqlite` (Core Data)                    | `…/group.com.apple.iBooks/Documents/BKJaliscoServerSource`                                                 | `purchases`                                                      |
| `BookTheme.sqlite` (Core Data)                                          | `…/com.apple.iBooksX/Data/Library/Application Support/Books`                                               | `themes`                                                         |
| `com.apple.iBooksX.plist`, `group.com.apple.iBooks.plist`               | `Library/Preferences` of each container                                                                    | `readingGoal`                                                    |
| Book files                                                              | the `ZPATH` of each asset, usually `~/Library/Mobile Documents/iCloud~com~apple~iBooks/Documents`          | `bookFiles`                                                      |

A run opens only the stores that its selected streams read. It pins each database in one read transaction. Every store uses the persistent WAL of Core Data, and most current rows are only in the WAL. Thus the reader opens each store read-only, and never as `immutable`, because `immutable` hides the WAL ([ADR 0001](./docs/adr/0001-the-stores-are-read-only-and-never-immutable.md)).

The stores are different files. Thus streams of different stores can show different times. A store that the source cannot open fails only its own streams:

- A missing or unreadable file fails with `BooksUnavailableError`. The message names Full Disk Access.
- A database that does not have a column that the reader reads fails with `MissingColumnsError`.
- A reading history in a different format version fails with `BooksSchemaError`. Two live reading history documents, or a document that is not bytes, also fail with `BooksSchemaError` ([ADR 0002](./docs/adr/0002-a-reading-history-that-cannot-be-read-fails-and-keeps-its-rows.md)).

The rows that the copies loaded before stay. Only a store with no reading history document, or with a document that has no data yet, reads as empty.

## Access

On macOS 27, a terminal without Full Disk Access read both containers and iCloud Drive. macOS can ask a process that it attributes to a different app for access to the data of other apps. Full Disk Access covers both cases. See [Full Disk Access](../messages/README.md#full-disk-access). Books has no public API or scripting dictionary for its library or annotations.

## Streams

| Stream                                          | Contents and relationships                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libraryAssets`                                 | Every book, PDF, audiobook and series in the library on this Mac: title, authors, genre, language, description, store and EPUB identifiers, `path`, page count, size, reading progress and the furthest progress, finished state and date, last opened and engaged, ratings, sample, hidden and explicit flags, series membership (`seriesContainerAssetId`). `contentType` is `epub` (code 1) or `pdf` (code 3). For other codes, only `contentTypeCode` has a value. `state` does not tell whether the file is local. The archived lists of authors, narrators and genres stay base64. |
| `collections`, `collectionMembers`              | The built-in collections (Finished, Want to Read, Books, PDFs, Downloaded, My Samples, Library, Audiobooks, with fixed `collectionId`s) and the collections that the user made (UUIDs). Members refer to their book by `assetId`. A member stays after its book leaves the library.                                                                                                                                                                                                                                                                                                      |
| `bookFiles`                                     | One row for each asset with a path: `format` (`epub-package` or `file`), `availableLocally`, the number of files, the size, and the latest change time in the package. An EPUB package loads as one `.epub` file. A single file, for example a PDF or a zipped `.epub`, loads as it is ([ADR 0003](./docs/adr/0003-a-book-file-is-copied-only-when-its-bytes-are-on-this-mac.md)).                                                                                                                                                                                                       |
| `annotations`                                   | Highlights and underlines (`kind` `highlight`, with `underline` and `style`: 0 underline, 1 green, 2 blue, 3 yellow, 4 pink, 5 purple), the reading position that Books keeps for each book (`kind` `readingPosition`), and deletion markers that are not synced yet (`deleted`, with no book, text or location). Text, note, surrounding text, chapter title, EPUB CFI location and offsets, creator and times.                                                                                                                                                                         |
| `assetDetails`                                  | Reading state that `bookdatastored` syncs through iCloud, also for books that the user read on other devices and that are not in this library: progress, furthest progress, finished and still reading, star rating, audiobook position, and the synced position as an EPUB CFI.                                                                                                                                                                                                                                                                                                         |
| `reviews`                                       | Store reviews that the user wrote.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `readingMonths`, `readingDays`, `streakRecords` | The reading history. For each day: the seconds of reading (the sum of the contributions of all devices) and the goal on that day. For each month: the total that Books kept when it summarized the month, and the number of days that remain. For each streak length: the date when the user first got it.                                                                                                                                                                                                                                                                               |
| `readingGoal`                                   | One row: goals on or off, the daily goal in seconds, when the user set it, and the current streak.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `purchases`                                     | Store purchases, downloaded or not. Download tokens and DRM parameters do not load.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `themes`                                        | Reading themes that the user changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

The source does not read these:

- CloudKit mirrors that copy the stores above: `ZBCASSETANNOTATIONS`, `BCCloudCollections`, `ZBCREADINGNOWDETAIL` and the widget cache. Also the local copy of the reading history (`CRDTModelLocalFile`, a newer format of the same model).
- Sync bookkeeping: `ACHANGE`, `ATRANSACTION*`, sync versions, server change tokens, salts, edit and sync generations, `ZCKSYSTEMFIELDS`, CRDT counters and replicas, and `.bcck` files.
- Engagement records for each day in `BDSSecureData`. They are store impression events, not reading time.
- Temporary tables: reading sessions, which Books purges, recents, and the purge and download queues.
- Telemetry and caches: `BooksMessages`, TipKit, WebKit, the series cache, archived property lists, and `Books.plist`, whose local flags are wrong.
- The theme fonts for each language.
- Secrets: `ZBCSECUREUSERDATUM`, identity tokens, CloudKit user IDs and DRM columns.

## Reading history

The reading history is a Coherence document (the CRDT framework of Apple), with the signature `crdt` and format version 4. `bookdatastored` syncs it through CloudKit. Its root struct has two dictionaries:

- `months`, from `yyyymm` to month objects.
- `streakRecords`, from a streak length to the date when the user got it.

A month holds `days` (from the day of the month to day objects) and `lastDayStreakOrdinal`. When Books summarizes a month, it drops the days and keeps `totalTime`. A day holds `readingTime`, a counter where each device keeps its decrements and increments, and `readingGoal`. Months and days are calendar dates in the time zone where Books recorded them.

## Book files

Most books are in iCloud Drive. Often they are placeholders, and their bytes are not on this Mac. When a process reads a placeholder, or lists a placeholder that is a directory, macOS downloads it. Thus the reader reads the BSD flags of each item with `/usr/bin/stat`, because the `stat` of Node.js does not give them. It lists a package directory only after the flags of the directory show that it is local, and it examines each entry before it goes into it. When one item is a placeholder, the book has `availableLocally: false` and no file.

An EPUB package loads as one OCF `.epub` file: `mimetype` is the first entry and is stored without compression, the other entries are in name order, and the timestamps are fixed. Thus a package that did not change gives the same bytes.

## Changes and deletions

Every stream is a [snapshot stream](../../../elt/README.md#snapshot-streams): each run diffs a full read of its store with the previous read. A record that is no longer in the store is deleted from the destination.

A watch polls each store every second. For a database, it reads `data_version`, which changes on each commit by a different connection, also while Books and `bookdatastored` keep their WALs open. For the two preference files, it reads their `stat`. A watch wakes only the streams of the stores that changed.

A book that macOS downloads from iCloud does not change a Books store. Thus a watch does not see it. The next change of the library, or the next run, loads the book.

## Live checks

Checked live on 2026-10-01 on macOS 27.0 with Books 8:

- The stores held 49 library assets (47 EPUB packages and 2 PDFs, all added through iCloud Drive), 8 built-in collections with 114 members, 240 annotations (193 highlights, 38 reading positions, 9 deletion markers with an empty asset ID), 63 synced asset details (14 for books not in this library), 42 months and 18 days of reading history, and 7 streak records. The goal was stored as 1800, and the settings of Books showed 30 minutes. Thus reading time and goals are seconds.
- With `immutable=1`, the library showed 0 annotations. Read-only, it showed all 240.
- 11 EPUB packages were local. 36 EPUBs and the 2 PDFs were placeholders. `Books.plist` listed 13 books as local, and 10 of them were placeholders. Two loads changed the flags of no item.
- A local book stayed open in Books in a background window for about 15 minutes. After Books quit, the reading history had the current month and a day of 487. This agrees with seconds.
- One highlight changed through yellow, green, blue, pink, purple and underline. Books stored `style` 3, 1, 2, 4, 5 and 0, and set `underline` only for 0.
- The 11 local EPUBs loaded as `.epub` files that `unzip -t` accepts. A second load wrote nothing and kept the same copies.

Not verified: content type codes and annotation type codes that this library does not use; audiobooks, store purchases and reviews (the examined Mac had none).

## Limitations

- Every stream deletes the rows of records that leave its store.
- Streams of different stores can show different times.
- The source does not download books from iCloud. A book whose bytes are not on this Mac has `availableLocally: false` and no file.
- The archived lists of authors, narrators and genres load as base64.
- Audiobooks, store purchases and reviews are not verified on a real Mac.

## Decisions

- [ADR 0001](./docs/adr/0001-the-stores-are-read-only-and-never-immutable.md): the stores are read-only and never `immutable`.
- [ADR 0002](./docs/adr/0002-a-reading-history-that-cannot-be-read-fails-and-keeps-its-rows.md): a reading history that cannot be read fails and keeps its rows.
- [ADR 0003](./docs/adr/0003-a-book-file-is-copied-only-when-its-bytes-are-on-this-mac.md): a book file is copied only when its bytes are on this Mac.

## Development

Run the commands from the workspace root.

```sh
npx nx run source-apple-books:test        # builds, then runs src/*.test.ts
npx nx run source-apple-books:typecheck   # formats, lints, then type checks
```
