# A watch polls the data version of chat.db

A watch must find each commit that Messages makes to `chat.db`. Messages writes through a WAL that it keeps open. FSEvents reports a write to such a file only when the file closes. Thus FSEvents does not see most commits.

SQLite changes `PRAGMA data_version` on a connection when another connection commits to the database. Thus `observe()` opens its own read-only connection and reads `data_version` each second. When the value changes, the watch gives all streams that it watches. Each commit changes the value, also the commit when an attachment download ends.

## Considered Options

- **FSEvents on `chat.db` and its WAL.** It does not see writes to an open WAL.
- **Poll `PRAGMA data_version` each second.** This option was selected.

## Consequences

- A watch finds a commit in approximately one second.
- A watch does not read rows. It only tells the pipeline to run the copies again.
- The watch uses `pollChanges` from `@zukhruf/async`.

## Sources

- 8afb65ef: watching polls `PRAGMA data_version`, because FSEvents misses writes to an open WAL.
- 2ab585af (#3239): the sources watch their stores through `pollChanges` of `@zukhruf/async`.
