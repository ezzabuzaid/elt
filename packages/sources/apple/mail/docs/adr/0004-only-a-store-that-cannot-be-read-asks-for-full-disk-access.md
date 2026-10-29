# Only a store that cannot be read asks for Full Disk Access

`MailUnavailableError` tells the user to give Full Disk Access. The source turned each failure to find the version folder into this error. A `PersistenceInfo.plist` that did not parse, for example a truncated one, thus sent the user to System Settings for a file that the reader cannot read. A watch turned no failure into this error: a store without its version file or its index stopped the watch with the error of `plutil` or SQLite.

Thus the source reads `PersistenceInfo.plist` before it parses it. A file that is missing, or that the process may not read (`ENOENT`, `EACCES`, `EPERM`), gives `MailUnavailableError`, which names the Mail store. A file that the process reads but cannot parse fails with its own error. The watch reads the `data_version` of the index through the shared app-database probe, which turns the SQLite errors for a file that cannot open into the same unavailable error. A read and a watch name the root of the Mail store. A version folder name that Mail does not write gives `MailSchemaError`. An index that is not a database fails with its own error.

## Considered Options

- **Each failure to open the store asks for Full Disk Access.** Then a damaged file sends the user to the wrong fix.
- **Only a file that is missing or not readable asks for Full Disk Access.** This option was selected.

## Consequences

- A host tells the user to give access only when access is the fix. `MailUnavailableError` is in the `configErrors` of the source.
- A damaged `PersistenceInfo.plist` or index shows its real error.

## Sources

Commit 87a12b28.
