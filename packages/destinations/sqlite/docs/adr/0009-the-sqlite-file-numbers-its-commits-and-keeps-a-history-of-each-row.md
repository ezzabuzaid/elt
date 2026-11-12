# The SQLite file numbers its commits and keeps a history of each row

A reader such as eca compares the SQLite file at two times, for example to find each key that matches a condition now and did not match it before. Before this decision the file kept only its current rows. A reader that wanted the file as it was had to keep its own copy, with keys, and a restart lost the changes between two of its reads.

Now the file gives the reader three things, as SQL Server change tracking does with `CHANGE_TRACKING_CURRENT_VERSION`, `CHANGETABLE(… @since)` and `MIN_VALID_VERSION`:

- **Positions.** Each commit gets a number in `_elt_commits`, inside its own transaction. `_elt_loads` records each pass and each refresh of a computed dataset. A position is the last commit of a closed load when no other load has commits before and after it, as a Kafka consumer reads up to the last stable offset. Thus a reader at a position sees no part of a pass.
- **History.** Each row has `committed_in`. Before a commit changes or removes a row, it copies the row into `_elt_history_<hash>` with `replaced_in`, the number of the commit. This is the shape of a SQL:2011 system-versioned table, which SQL Server keeps as a current table and a history table. A reading as of position P reads each current row with `committed_in ≤ P` and each history row with `committed_in ≤ P < replaced_in`. `asOfSelect` gives that `SELECT`, and a reading makes it a `TEMP` view for each table.
- **Difference.** An overwrite and a reload compare the rows as multisets by `_elt_row_hash`. A row that comes again stays, with its `committed_in` and its `loaded_at`. Thus the history grows only with changes, not with each full refresh.
- **Retention.** The history keeps a position readable for the retention of the destination, 30 days by default, as Delta Lake keeps its log. In each commit, let W be the newest position whose commit is older than the window. The commit deletes each history row with `replaced_in ≤ W`, and each stored file that only those rows refer to. It sets min valid, a column of `_elt_epoch`, to W. A position older than min valid gives `{ expired }` with a reason that names the retention, as a change tracking query before `MIN_VALID_VERSION` must start again.

## Considered Options

- **The reader keeps keys and its own copy.** Each reader must then store the file again, and a restart misses a key that stopped matching and then matched again.
- **A copy of the file for each position.** Simple to read, but each pass copies every row.
- **Numbered commits, a history table and retention in the destination.** This option was selected.

For retention:

- **W is the newest commit older than the window.** A pass that stays open longer than the window then expires the newest position, and no reading is possible until the pass ends. W is therefore the newest _position_ older than the window, so min valid never passes the newest position.
- **A separate cleanup job.** Somebody must then run it. Each commit already holds the write lock, and the deletes use the index on `replaced_in`, so each commit applies the retention.

## Consequences

- A reader keeps a position and nothing else. A file that is made again has a new epoch, so an old position is expired.
- The chunks of a stored file go in the commit that deletes the last history row that refers to them. A file in a file storage goes when the stream of its table next commits: only the pipeline knows the file storage, and it keeps the files that the rows and the history refer to after each commit.
- The sync history and the definitions of views keep no versions. A reading as of a position fails each read of the sync history, and each view uses its SQL of now.
- A stored view that names a table as `main.<table>` makes a reading as of a position fail, because that name shows the table as it is now.
- `_elt_commits` keeps a row for each commit. Retention deletes no row of it.
