# Each read checks only the columns of its tables

The Accounts store has many tables, and Mail reads only the account tables. A change of an unrelated table in a new macOS must not stop Mail. Thus `AccountsSnapshot` checks the columns of a table when it reads that table, not when the snapshot opens.

The first check used `requireColumns`, which closes the database before it throws. After the first missing column, every later read of the same snapshot failed with `database is not open`, and that error named nothing. Now each read gets the missing columns with `missingColumns`, which has no side effect, and throws `MissingColumnsError` with the names of the columns. The snapshot stays open for the other reads.

## Considered Options

- **Check every column when the snapshot opens.** One missing column then stops Mail too.
- **Check each read with `requireColumns`.** The snapshot closes, and the later reads fail with no name.
- **Check each read with `missingColumns`, and keep the snapshot open.** This option was selected.

## Consequences

- A store without a column fails only the streams that read its table. The other streams load.
- The Notes, Messages, Safari and Call History SDKs read the same tables in all streams. They check every column when the snapshot opens.

Sources: commit 106ab8fc, backlog item 2302; commit 6c375e65 (the error is `MissingColumnsError`).
