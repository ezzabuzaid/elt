# The keyword index is a member that keeps a keywords table and its full-text index in step

A keyword search of `@zukhruf/retrieval` reads a full-text index of the passages ([its ADR 0004](https://github.com/JanuaryLabs/zukhruf/blob/main/packages/retrieval/docs/adr/0004-a-keyword-retriever-queries-the-keyword-index-that-elt-writes.md)). On SQLite it joins the passages to an FTS5 table by `rowid`, and ranks with `bm25()`. No kind of derived dataset of elt makes a full-text index, so the vectorizer has a kind of its own, the keyword index.

## Decision

The keyword index is a member of the vectorizer. On SQLite, for a vectorizer named `docs`:

- The table `docs_keywords` has `rowid INTEGER PRIMARY KEY`, `id` (unique), `source`, `seq` and `text`, and is unique on `source` and `seq`. The passages view joins the parts on `source` and `seq`, which an index finds.
- The FTS5 table `docs_passages_fts` has the column `text`, with `content = 'docs_keywords'` (the amendment of 2026-11-24 to ADR 0004 of `@zukhruf/retrieval`). Its `rowid` is the `rowid` of the keywords table, which the passages view gives.
- Three triggers on the keywords table, after an insert, a delete and an update, write the same change into the FTS5 table. The member never writes the FTS5 table itself.
- The table, the FTS5 table and the three triggers are one declaration of `@zukhruf/sqlite-drift`, with `rows: 'replace'`. When one of them differs from the declaration, the refresh makes all five again, and the refill fills the FTS5 table through the insert trigger. When an object is missing and none is stale, the refresh makes only the missing object, before it writes.
- A refresh is one transaction (`BEGIN IMMEDIATE`): it applies the declaration, writes each part whose text changed, and deletes each row that no part has. A reader sees the index of one refresh or of the next, never a part of one.
- After the transaction, the member writes `current` in `derived_status` with kind `computed`, the parts as `inputs` and its rows as `computed`. It has no `refreshing` state: its refresh is one synchronous transaction. On a failure, it writes `failed` and the error, unless a stop ended the refresh. While the parts table of the chunks is not there yet, it writes `waiting`.
- A keyword index is always written. A host that wants no keyword search does not read it.

## Considered Options

- **The FTS5 `'rebuild'` command after a remake.** The decision of #5401 named it ("FTS5 external content over docs_keywords (rebuild on remake)"). The main session of the build dropped it on 2026-11-24, for the reason that follows; Ezz did not rule on the drop itself. One declaration already makes the table, the FTS5 table and the triggers again together, so the refill through the trigger fills the index, and FTS5 `integrity-check` passes after a remake (probe of 2026-11-24). A `'rebuild'` would then do nothing, and no test could show that it is needed. A malformed index came only from a remake of the keywords table alone, while the FTS5 table stayed, which one declaration cannot do.
- **An FTS5 table with its own content.** It keeps a second copy of each text, and `bm25()` and the join by `rowid` need the content table anyway.
- **The member writes the FTS5 table in its refresh.** Each write then has two statements that must agree. The triggers keep them together in SQLite itself.
- **A column `keywords_populated` in the status view.** On SQLite the index is searchable in the same commit as the rows, so the column would always be true. The state of the member in `derived_status` already tells it.
