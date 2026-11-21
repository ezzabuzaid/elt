# A rule reads a stored file through its storage

`FileStorage` could only write: `save`, `flush` and `retain`. Thus `DocumentText` did not read through it. It took the folder of a `LocalFiles` (`files: files.directory`), and joined each ref to that folder to get a path for the parser. The ref is text that only its storage resolves (ADR 0015), so the folder join was a leaky abstraction: a reader knew the form of the refs of one storage.

The leak blocks a storage that keeps no files on a disk. datahub runs its writer in an App Service container that gets a fresh disk at each deploy or restart, so its SharePoint documents must stay in the warehouse database (#5170, Ezz, 2026-11-21: "Keep files in SQL Server"). A folder join cannot read a file from a database.

Thus `FileStorage` has a read half:

- `open(ref, signal?)` gives `{ path } & AsyncDisposable`, a path that stays readable until it is disposed. `LocalFiles` gives its own file, and its dispose does nothing. A storage in a database gives a temporary copy, and its dispose removes it.
- `head(ref, length, signal?)` gives the first bytes of a stored file, with no copy of the whole file.
- A ref that the storage does not hold throws a `StoredFileMissingError`, whose message the storage writes. The error of `LocalFiles` names its folder and the ref, and tells you to reload the copy that stored the file (#5166). A reader routes by this type: only this error is the failure of one file. Each other error is a failure of the storage.

`DocumentText({ parser, files, column })` takes the `FileStorage`. It opens each file with `files.open(ref)`, gives the path to `parse(path, signal?)`, and disposes the file after the parse. `DocumentParser.identityFor` takes `{ name, head(length) }` in place of a path: `name` is the file name of the ref, with its extension, and `head` reads through the storage only when the parser calls it. `parse` keeps its path, because the parsers (PDFKit, `textutil`, officeparser) read paths.

## Considered Options

- **The database is one more `FileStorage`.** A destination gives a storage with the same interface as `LocalFiles`, so the copy saves, flushes and reconciles its files with the machinery that exists, and a rule reads them through the same port (Ezz, 2026-11-22: "treat the db as local files ... same interface so we don't need to rebuild machinery once more"). Views keep working, because a ref is text that the storage resolves. This option was selected.
- **The destination redeems its blob columns.** `blob().from(file)` kept the bytes of a file in chunk tables of each destination, and a rule would read the bytes back from the destination. That is a second mechanism for the bytes of a file beside `FileStorage`, with its own ids, prune and history. Nothing outside tests declared it in elt, Context Compiler or datahub, so it was removed first (#5170 step E1), and a plain inline `blob()` column stays.
- **The host passes a reader.** `DocumentText` would take a function from the host that turns a ref into a path. Each host then knows the form of the refs of its storage, which is the leak of the folder join again, and each host writes the resolution once more.

## Consequences

- Each `FileStorage` implements `open` and `head`. A storage in the database of SQLite, Postgres or SQL Server (#5170 step E3) gives temporary copies from `open`, and reads only the first bytes for `head`.
- `identityFor` is asked for each input at each refresh. A parser with a constant identity, such as `OfficeDocumentParser`, reads no bytes. `MacOSDocumentParser` reads 4100 bytes through `head`, never a whole copy.
- `DocumentText` keeps its outcomes: a parse failure and a file that the storage does not hold fail only their row, a stop leaves no row, and a file that the parser does not handle is empty. Each other error of `open`, such as a folder that this process may not read, fails the refresh, as the check of the folder after a failed parse did before.
- `LocalFiles` stays, with its reconcile and `.store()`. The agent of Context Compiler opens its stored files by path.

Sources: backlogs #5166 and #5170; ADR 0015.
