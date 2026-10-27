# @workspace/source-apple-books

An ELT source for Apple Books: the library, collections, highlights and notes, reading state that iCloud syncs, reading history and goal, store purchases and reviews, themes, and the book files that are on this Mac. It reads the stores that Books and its sync daemon `bookdatastored` keep in Books' container and group container. It does not use the network, and Books does not have to be open.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { AppleBooksSource } from '@workspace/source-apple-books/apple-books-source';

const source = new AppleBooksSource();
const destination = new SQLiteDestination({ path: './books.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'apple-books',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({ path: './books-state.sqlite' }),
      steps: [source.libraryAssets, source.annotations, source.readingDays].map(
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

| Stream                                          | Contents                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `libraryAssets`                                 | every book, PDF, audiobook and series in the library on this Mac                            |
| `collections`, `collectionMembers`              | built-in collections, the collections that the user made, and their books                   |
| `bookFiles`                                     | one row for each book with a path; it supports file transfer                                |
| `annotations`                                   | highlights, underlines and notes, and the reading position for each book                    |
| `assetDetails`                                  | reading state that iCloud syncs, also for books that are not in this library                |
| `reviews`                                       | store reviews that the user wrote                                                           |
| `readingMonths`, `readingDays`, `streakRecords` | reading history: seconds of reading for each day, totals for each month, and streak records |
| `readingGoal`                                   | one row: the daily goal in seconds and the current streak                                   |
| `purchases`                                     | store purchases, downloaded or not                                                          |
| `themes`                                        | reading themes that the user changed                                                        |

To copy the bytes of the books, give the `bookFiles` copy a column from `source.bookFiles.file`. The reference shows an example.

Access: on macOS 27, a terminal without Full Disk Access read both containers and iCloud Drive. macOS can ask a process of another app for access to the data of other apps. Full Disk Access covers both cases. A store that the source cannot open fails only its own streams, with `BooksUnavailableError`. A store that does not have a column that the source reads fails with `BooksSchemaError`.

Limitations:

- Every stream compares a full read of its store with the previous read. A record that is no longer in the store is deleted from the destination.
- The stores are different files. Thus streams from different stores can show different times.
- Most books are in iCloud Drive, and often their bytes are not on this Mac. The source does not download them. Such a book has `availableLocally: false` and no file.
- Audiobooks, store purchases and reviews are not verified on a real Mac.

See [docs/reference.md](../../../../docs/reference.md#apple-books).
