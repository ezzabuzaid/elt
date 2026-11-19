# A key is indexed by its hash

Status: proposed, for Ezz's review (2026-11-19).

A deduplicating load upserts on a unique index of the key (elt-postgresql: `_elt_dedup_<hash>`), and a computed dataset keeps one output row for each key (elt-sqlite ADR 0002). Two facts of SQL Server stop a plain unique index on the key columns:

- An index key holds at most 1,700 bytes for a nonclustered index, and an `NVARCHAR(MAX)` column cannot be a key column. A key of text is `NVARCHAR(MAX)` (README, Columns), and a SharePoint ref or a URL can be long.
- A unique index on `NVARCHAR` compares by the collation of the column. The default collation ignores case, so the keys `A` and `a` would be one row. SQLite and Postgres keep them apart, and the upstream keeps them apart (elt ADR 0022).

Fivetran limits a string key of SQL Server to 256 bytes ([Fivetran SQL Server](https://fivetran.com/docs/destinations/sql-server)). Debezium needs a key column type that can be a primary key, and its users list the key columns ([Debezium JDBC sink](https://debezium.io/documentation/reference/stable/connectors/jdbc.html)).

## Decision

- The load computes `_elt_key_hash BINARY(32)`, the SHA-256 of the JSON array of the key values, when it stages a row, as it computes `_elt_row_hash`.
- A deduplicating table has a unique index on `_elt_key_hash`. The `MERGE` of a commit matches on it (ADR 0005).
- The raw table of a computed dataset has its key as `NVARCHAR(MAX)` and a unique index on `_elt_key_hash`.
- `_elt_key_hash` is an internal column.

## Considered Options

- **Key columns of a bounded type, such as `NVARCHAR(850)`, with a plain unique index.** A longer key fails its commit, and the collation must be binary.
- **A persisted computed column of `HASHBYTES('SHA2_256', …)`.** It needs one expression for each shape of key, and it hashes the SQL value, which differs from the value that the load computed.
- **A hash that the load computes.** No limit of length, binary equality, and one rule for each shape of key. This option was selected.

## Consequences

- Any key loads, of any length, and two keys that differ only in case stay two rows.
- The chance that two keys share a SHA-256 is too small to count.
- A reader joins on the key columns, not on the hash.

Sources: elt-postgresql README, Locks and commits (deduplication); elt ADR 0022.
