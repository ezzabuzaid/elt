# A Change Tracking position carries the tracking generation

Microsoft documents how to read Change Tracking: compare the saved version with `CHANGE_TRACKING_MIN_VALID_VERSION`. When the saved version is below the minimum, the history no longer covers it, and the reader must load the table again. This misses a `TRUNCATE` made just after a sync. A truncate moves the minimum valid version to the current version. When nothing changed between the sync and the truncate, the minimum then equals the saved version, and the check passes. Change Tracking reports no deletion for the rows that the truncate removed.

Thus a position is a Change Tracking version and the table's tracking generation: its `begin_version` and the creation time of its change table in `sys.internal_tables`. A truncate moves `begin_version` to the current version. Enabling tracking again makes a new change table. When the saved position is below the minimum valid version, ahead of the database's current version, or of a different generation, the stream sends `RESET` and loads every row again into a hidden target.

## Considered Options

- **Compare the saved version with the minimum valid version only, as Microsoft documents.** A truncate just after a sync then goes unseen.
- **Save the tracking generation with the version, and compare both.** This option was selected.

## Consequences

- A truncate just after a sync, and tracking turned off and on, are seen, and the table loads again.
- One case is left: a table whose tracking began at the version that the last sync read, with no tracked change in the database since. No metadata that a read-only login can see changes then. The README lists it as a limitation.
- `VIEW CHANGE TRACKING` makes the change table's `create_date` visible, so the login needs no more grants.

## Sources

- Commit 85a12bf2: the SQL Server source, with the generation in each position.
