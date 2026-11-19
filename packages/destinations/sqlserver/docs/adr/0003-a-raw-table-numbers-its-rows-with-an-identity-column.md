# A raw table numbers its rows with an identity column

Status: proposed, for Ezz's review (2026-11-19).

An overwrite and a reload replace the rows of a table by difference (elt-sqlite README, Commit numbers and positions): the rows match as multisets by `_elt_row_hash`, so two rows with the same values are two rows, and the commit removes one of them and keeps the other. The difference must name one row of a table with no key. SQLite names it by `_rowid_`, and Postgres by `ctid`. SQL Server has no documented row locator: `%%physloc%%` is undocumented, and it changes when a row moves to another page.

A raw table with no key would also be a heap. Microsoft advises a clustered index for a table that has updates and deletes, because a heap keeps forwarded records and does not free pages on delete without a table lock ([heaps](https://learn.microsoft.com/sql/relational-databases/indexes/heaps-tables-without-clustered-indexes)).

## Decision

- Each raw table and hidden table has `_elt_row BIGINT IDENTITY(1, 1) NOT NULL`, its clustered primary key.
- A difference, a reload in place, and the reset of a partition name a row by `_elt_row`, where Postgres names it by `ctid`.
- `_elt_row` is an internal column. The reader view does not show it, and the history does not keep it.

## Considered Options

- **`%%physloc%%`.** Undocumented, and not stable.
- **A deletable CTE with `ROW_NUMBER() OVER (PARTITION BY _elt_row_hash …)`.** SQL Server deletes through such a CTE with no locator, the classic way to remove repeated rows. But the table stays a heap, and the order of two equal rows is not stable between two statements.
- **The key columns.** An overwrite of a stream with no key has none.
- **An identity column that is the clustered key.** This option was selected.

## Consequences

- Each raw table is a clustered table, also with no key.
- An identity number is never given again, also after a delete, so the problem of SQLite's freed `rowid` does not occur.
- A swap of the hidden table keeps its own numbers; no reader sees them.

Sources: elt-postgresql `copied-from-elt-sqlite.md` (`#unmatched`, `#replace`, `#reloadInPlace`).
