# Only a store that cannot be read asks for Full Disk Access

Changed in part on 2026-11-13 (#4275): `StoreUnavailableError` of `@eltjs/sdk-macos-app-database` now says which of the two reasons it is, for each store. A path with no entry gives "is not there" and what makes the app create the store, when the store has such a text. A path that is there, or one that the system refuses to look at, gives "cannot be read" and the grant. Before, a store that is not there also named the grant: on a Mac whose Notification Center database was not there, the process had the grant and the error still asked for it. Two cases of Mail are open (#4306): a version file or an index that is not there inside a root that is.

`StoreUnavailableError` tells the user to give Full Disk Access. The source turned each failure to find the version folder into this error. A `PersistenceInfo.plist` that did not parse, for example a truncated one, thus sent the user to System Settings for a file that the reader cannot read. A watch turned no failure into this error: a store without its version file or its index stopped the watch with the error of `plutil` or SQLite.

Thus the source reads `PersistenceInfo.plist` before it parses it. A file that is missing, or that the process may not read (`ENOENT`, `EACCES`, `EPERM`), gives `StoreUnavailableError`, which names the Mail store. A file that the process reads but cannot parse fails with its own error. The watch reads the `data_version` of the index through the shared app-database probe, which turns the SQLite errors for a file that cannot open into the same unavailable error. A read and a watch name the root of the Mail store. A version folder name that Mail does not write gives `MailSchemaError`. An index that is not a database fails with its own error.

## Considered Options

- **Each failure to open the store asks for Full Disk Access.** Then a damaged file sends the user to the wrong fix.
- **Only a file that is missing or not readable asks for Full Disk Access.** This option was selected.

## Consequences

- A host tells the user to give access only when access is the fix. `StoreUnavailableError` is in the `configErrors` of the source.
- A damaged `PersistenceInfo.plist` or index shows its real error.

## Sources

Commit 87a12b28.
