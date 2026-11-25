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

## Amendment 2026-11-25: the keyword index on SQL Server

On SQL Server (S9 step E9), for a vectorizer named `docs`:

- The keyword index is the base table `marts.docs_keywords` (`id NVARCHAR(450) COLLATE Latin1_General_100_BIN2` as its primary key, `source NVARCHAR(450)` in the same collation, `seq INT`, `text NVARCHAR(MAX)`), with a full-text index on `text` whose key is the primary key: `STOPLIST = OFF` (the system stoplist gives an `AND` with a stop word no rows, S7 probe P9), `CHANGE_TRACKING AUTO`, and `LANGUAGE` the LCID of `keywords.language`, 1033 when absent. The full-text catalog has the name of the table. `CONTAINSTABLE` refuses a view (error 7601), so the retriever reads this table, and it is in `marts`, so a reader with `SELECT` on `marts` reads it (option (a) of the paper's D8, ruled).
- SQL Server makes a full-text catalog and index only outside a user transaction (error 574, probe P-MS1). So the member makes them as statements of their own. The table keeps the SHA-256 of its declaration as the extended property `elt_declaration`. When that hash differs, or the table has no full-text index, the refresh drops the index and the table, and makes them again. It writes the property last, so a make that stopped half way is made again. The refill gives each passage to the new index. Two refreshes of one index take turns through a session lock of `sp_getapplock` on `elt:marts.docs_keywords`.
- A refresh first reads zero rows of the parts table. While the chunks have no parts table, the member writes `waiting` and makes nothing. Then one `MERGE` writes each passage whose text changed (compared in binary) and deletes each passage that no part has. A single statement commits as one.
- After the `MERGE`, the member writes `refreshing`, and waits on the clock of the pipeline, under the signal of the refresh, until `TableFulltextPopulateStatus` is 0 and `TableFulltextPendingChanges` is 0, each cast to `INT` (they are `sql_variant`). Then it writes `current`. Both are needed: no change waits while the first population still runs (probe P-MS3, in the container). So `current` means that a search finds each passage. Azure SQL Database is checked at datahub's migration (owner ruling 7).
- A server with no Full-Text Search refuses `CREATE FULLTEXT CATALOG`. The member catches only error 7609 ("Full-Text Search is not installed, or a full-text component cannot be loaded", Microsoft's list of errors 7000 to 7999) and fails with a `SqlServerSetupError`, of failure type `config`, before it makes the table. The number comes from Microsoft's documentation. No probe ran on a server without Full-Text Search: SQL Server 2025 is emulated on the Mac of the build, and the test that proves it runs on CI.

## Amendment 2026-11-25: the keyword index on Postgres

On Postgres (S9 step E8), for a vectorizer named `docs`:

- The table `_warehouse.raw_docs_keywords` has `id text COLLATE "C" PRIMARY KEY`, `source`, `seq`, `text`, and `keywords tsvector GENERATED ALWAYS AS (to_tsvector('<configuration>'::regconfig, text)) STORED`, and is unique on `source` and `seq`. A GIN index `raw_docs_keywords_gin` indexes `keywords`. This is the form of the Postgres amendment of ADR 0004 of `@zukhruf/retrieval`, and LlamaIndex's `text_search_tsv`. Postgres makes the `tsvector` itself, so the member writes only the text, and no trigger is needed.
- The configuration is `keywords.configuration` of the vectorizer, `'english'` when absent, the default of `PgvectorKeywordRetriever`. The contract gives it to the retriever, so the index and the search use one configuration.
- The table and its GIN index are one declaration. The table keeps the SHA-256 of the declaration as its comment. When the comment differs, for example after a change of the configuration, the refresh drops the table and each view over it (`CASCADE`), and makes it again. The refill then gives each passage its keywords in the new configuration. The passages view refreshes after the keyword index, so it is made again in the same refresh. A view of a person over the passages is gone, as a withdrawn view of elt-postgresql is.
- A refresh is one transaction under an advisory lock of the table, so two refreshes of one index take turns: it brings the declaration in place, writes each part whose text changed, and deletes each row that no part has. A reader sees the index of one refresh or of the next.
- The member writes its row of `_warehouse.derived_status` as `_warehouse.raw_docs_keywords`, the relation that it makes, with kind `computed`. A view after it that reads the table waits while the index waits. While the parts table of the chunks is not there yet (SQLSTATE `42P01` for that table only), it writes `waiting`.

## Considered Options

- **The FTS5 `'rebuild'` command after a remake.** The decision of #5401 named it ("FTS5 external content over docs_keywords (rebuild on remake)"). The main session of the build dropped it on 2026-11-24, for the reason that follows; Ezz did not rule on the drop itself. One declaration already makes the table, the FTS5 table and the triggers again together, so the refill through the trigger fills the index, and FTS5 `integrity-check` passes after a remake (probe of 2026-11-24). A `'rebuild'` would then do nothing, and no test could show that it is needed. A malformed index came only from a remake of the keywords table alone, while the FTS5 table stayed, which one declaration cannot do.
- **An FTS5 table with its own content.** It keeps a second copy of each text, and `bm25()` and the join by `rowid` need the content table anyway.
- **The member writes the FTS5 table in its refresh.** Each write then has two statements that must agree. The triggers keep them together in SQLite itself.
- **A column `keywords_populated` in the status view.** On SQLite the index is searchable in the same commit as the rows, so the column would always be true. The state of the member in `derived_status` already tells it.
