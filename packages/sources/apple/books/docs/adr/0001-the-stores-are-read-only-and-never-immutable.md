# The stores are read-only and never immutable

Books and `bookdatastored` write their Core Data stores through a persistent WAL. Most current rows are only in the WAL. SQLite reads a database opened as `immutable` without its WAL. On 2026-10-01, the annotations store opened with `immutable=1` showed 0 annotations, and the same store opened read-only showed all 240.

Thus the source opens each store read-only, and never as `immutable`. A run opens only the stores that its selected streams read, and it pins each database in one read transaction.

## Considered Options

- **Open each store as `immutable`.** No lock is taken, but the rows in the WAL do not show.
- **Open each store read-only in one read transaction.** This option was selected.

## Consequences

- A run reads the rows that Books committed to the WAL.
- Each store is a different file. Thus streams of different stores can show different times.
- A store that the source cannot open fails only its own streams, with `BooksUnavailableError`.

Sources: commit 5dcd0609 (the Books source), commit 65c7e39c (the SDK `sdk-apple-books`).
