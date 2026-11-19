# The raw table shares the file with its reader view

Status: proposed. Ezz chose this rule on 2026-11-19. The text waits for review before any code (backlog #4886).

ADR 0028 of elt lets a host name only the reader view of a target, and the destination places the raw table. A SQLite file has no schemas. Other files can be attached under a name. But the SQLite file of this destination has a persistent write-ahead log, and SQLite makes a transaction atomic across attached files only when the journal mode is not WAL: "If the main database is ":memory:" or if the journal_mode is WAL, then transactions continue to be atomic within each individual database file. But if the host computer crashes in the middle of a COMMIT where two or more database files are updated, some of those files might get the changes where others might not." The commit that changes a raw table must change its history and its reader view in the same transaction.

Thus the raw table of the reader view `<name>` is `raw_<name>`, in the same file, as the raw table of a computed dataset already is. `new SQLiteDestination({ path }).table('notes')` makes the view `notes` and the table `raw_notes`.

## Considered Options

- **The raw tables in an attached file.** A crash during a commit can leave a reader view over a table that the commit did not change.
- **The same file, with names that the destination picks.** This option was selected.

## Consequences

- A reader that opens the file can still read `raw_<name>`, because SQLite has no roles. Only `catalog` guides the reader to the views.
- The name of a raw table follows the reader name. When a host names the view `inline_attachments`, the raw table is `raw_inline_attachments`.
- The destination refuses a reader name that is the name of a relation that it makes, such as `catalog` or the raw table of another reader view.

Sources: #4886; ADR 0028 of elt; sqlite.org/lang_attach.html.
