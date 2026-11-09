# Test helpers copied between packages

Many test files in this repo read a destination's SQLite file, and many write Core Data dates into a fixture. This note records where each helper is, which copies stay, and why.

A package exports no test support. So a test helper that several packages use stays copied in each package. Inside one package, the third place moves to that package's `src/testing/`. Until a package has three places, mirror every fix in each copy and name each file in the commit.

## SQLite row reader

The reader opens a SQLite file as read-only, runs one statement and returns its rows. The file closes when the reader returns. A row of `node:sqlite` has a null prototype, so a strict `deepEqual` with an object literal needs a copy of the row.

### Moved to `src/testing/`

These packages had three or more places. Each one now has `src/testing/stored-rows.ts` (`storedRows`), and the two files are the same.

- `packages/destinations/sqlite`: six places, in `index.test.ts` (four), `snapshot-memory.test.ts` and `sqlite-passes.test.ts`.
- `packages/sources/apple/calendar`: three places, in `calendar-source.test.ts`. One of them returned rows without a copy. Its callers read fields, so the copy does not change them.

`tsconfig.lib.json` of each package excludes `src/testing/**`, so `dist` holds no test code.

### Copied, one place in the package

| Package in `packages/sources` | Reader                           | Rows              |
| ----------------------------- | -------------------------------- | ----------------- |
| `apple/accounts`              | `rows(path, sql)`                | copies            |
| `apple/activity`              | `read(sql)` in the test's import | copies            |
| `apple/books`                 | `read(sql)` in the test's import | not copied        |
| `apple/call-history`          | `rows(path, sql)`                | copies            |
| `apple/clock`                 | `rows(directory, sql)`           | copies            |
| `apple/notification-center`   | `rows(path, sql)`                | copies            |
| `apple/safari`                | `read(sql)` in the test's import | not copied        |
| `apple/wallet`                | `rows(path, sql)`                | copies            |
| `arc/desktop`                 | `read(sql)`                      | copies            |
| `chromium/browser`            | `read(sql)` in the test's import | changed, see note |
| `dia/desktop`                 | `rows(path, sql)`                | copies            |
| `instagram/web`               | `rows(directory, sql)`           | copies            |
| `microsoft/teams`             | `rows(path, sql)`                | copies            |
| `slack/desktop`               | `rows(path, sql)`                | copies            |
| `web/pages`                   | `found(sql)` in `routes.test.ts` | copies            |
| `whatsapp/desktop`            | `rows(path, sql)`                | copies            |

Note: the Chromium reader also removes `loaded_at` and reads large integers as text, because a Chromium stream declares such a column as text.

### Copied, two places in the package

Each of these packages has one reader that returns rows without a copy and one that returns copies. A third place in one of them moves the reader to `src/testing/` (backlog #4048).

- `apple/contacts`: `read` and `rows` in `contacts.test.ts`.
- `apple/mail`: `read` and `rows` in `mail.test.ts`.
- `apple/messages`: `read` and `messagesRows` in `messages-source.test.ts`.
- `apple/notes`: `read` in `notes.test.ts` and `noteRows` in `notes-source.test.ts`.
- `apple/reminders`: `read` and `loaded` in `reminders-source.test.ts`.

### Not a copy

These do not count as the reader, because each does a different job.

- `packages/destinations/sqlite/src/index.test.ts`: the reader with `readBigInts` keeps integers that a number cannot hold.
- `packages/destinations/sqlite/src/view.test.ts`: `read` closes the folder to writes, because it tests a reader in a sandbox.
- A function that selects fixed columns and maps each row to its own shape. The map belongs to the test.

## Core Data reference date

`packages/codecs/apple-reference-date` reads a stored number as a date, and it exports the reference date as `referenceDateSeconds`, which SQL text can use. All production code reads the reference date from this codec. Its own test, `reference-date.test.ts`, keeps its literals. A test of other code uses the codec only when the test has another oracle. Otherwise the fixture and the code share one epoch, and a wrong epoch passes.

### Uses the codec

In these tests, `plutil` is the oracle, because it stores its own seconds.

- `packages/sources/apple/books`: `fromAppleSeconds`. The test gives a date to `plutil`. The sentinels `distantPast` and `distantFuture` stay literals in the test.
- `packages/sources/apple/safari`: `addFraction`. The test finds the seconds in the bytes that `plutil` wrote.

### Keeps the literal

In these tests, the code under test uses the codec, so the literal is the independent oracle.

- `packages/sdks/apple/knowledge/src/knowledge-store.test.ts`: the expected `startedAt`.
- `packages/sources/apple/accounts/src/accounts.test.ts`: `addedAt`.
- `packages/sources/apple/activity/src/activity.test.ts`: `appleEpoch` and `started`, because Biome's payload dates and the time of a record go through the codec.
- `packages/sources/apple/books/src/books.test.ts`: `appleSeconds`.
- `packages/sources/apple/call-history/src/call-history.test.ts`: `coreData`.
- `packages/sources/apple/contacts/src/contacts.test.ts`: `appleSeconds`.
- `packages/sources/apple/messages/src/messages-source.test.ts`: `appleNanoseconds`.
- `packages/sources/apple/notes/src/notes.test.ts` and `notes-source.test.ts`: `coreDataSeconds`.
- `packages/sources/apple/notification-center/src/notification-center.test.ts`: `appleTime`.
- `packages/sources/apple/safari/src/safari.test.ts`: `appleSeconds`.
- `packages/sources/apple/wallet/src/wallet.test.ts`: `appleTime` and the check of the stored expiration.
- `packages/sources/whatsapp/desktop/src/whatsapp-desktop.test.ts`: `coreData` and `statusSeconds`.
