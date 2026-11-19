# A batch travels as one JSON parameter that OPENJSON reads

Status: accepted by Ezz (2026-11-19).

Each stream stages its operations before each commit. elt-postgresql sends a batch of at most 1,000 rows or 16 MiB as one JSON parameter, and casts it for each column. The driver of SQL Server for Node, `mssql` on tedious, sends no `VECTOR` and no `JSON` value on the wire: Microsoft's driver matrix gives "No" for tedious and `VECTOR`, and tedious pull request [#1841](https://github.com/tediousjs/tedious/pull/1841) is open. For such a client, "SQL Server continues to expose vector data as varchar(max)", and it converts a JSON array to a vector ([vector data type](https://learn.microsoft.com/sql/t-sql/data-types/vector-data-type)).

The leaders:

| Tool                      | How rows travel                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Airbyte destination-mssql | `INSERT` statements, or files in Azure Blob Storage and `BULK INSERT` ([docs](https://docs.airbyte.com/integrations/destinations/mssql))               |
| dlt mssql                 | `INSERT` of at most 1,000 rows, because "MSSQL has a limit of 1000 rows per INSERT" ([docs](https://dlthub.com/docs/dlt-ecosystem/destinations/mssql)) |
| Meltano target-mssql      | a bulk insert into a `#` table ([`sinks.py`](https://github.com/storebrand/target-mssql/blob/main/target_mssql/sinks.py))                              |

## Decision

- A batch of at most 1,000 rows or 16 MiB goes as one `NVARCHAR(MAX)` parameter: a JSON array of the operations. `INSERT INTO #stage SELECT … FROM OPENJSON(@batch) WITH (…)` reads it, and casts each column, as Postgres casts `$1::json`.
- A vector goes as the JSON text of `toSql` of `@zukhruf/vectors/sqlserver`, with 9 significant digits, and lands with `CAST(… AS VECTOR(n))`. The probe of that package found no value changed on a write.
- Bytes go as base64 text and land through `BASE64_DECODE` of SQL Server 2025 (to probe).

## Considered Options

- **The bulk copy of TDS (`request.bulk` of `mssql`).** The fastest path, but tedious bulk copy has no `VECTOR` and no `JSON` type, so those columns still need a cast in a second step.
- **`INSERT … VALUES` of at most 1,000 rows, as dlt.** The text of each statement holds each value, and parameters are limited to 2,100 for each request.
- **Files in Azure Blob Storage and `BULK INSERT`, as Airbyte.** It needs a storage account and an external data source. This is "later", for a load that JSON batches make too slow.
- **One JSON parameter, read by `OPENJSON`.** One rule for every type, `VECTOR` and `JSON` included, and the same shape as elt-postgresql. This option was selected.

## Consequences

- A vector of 1,536 dimensions is about 15 KB of JSON text, so a batch of 64 vectors is about 1 MB. The probe of `@zukhruf/vectors` sent 250 vectors of 384 dimensions in 1.9 s.
- When tedious sends native vectors, a later decision can send them through a table-valued parameter or the bulk copy.
- To probe before code: `OPENJSON … WITH` and `CAST(… AS VECTOR(1536))` for a batch of 64 vectors, and the time of a batch of 1,000 rows of text.

Sources: elt-postgresql README, "Each commit"; `@zukhruf/vectors` ADR 0007.

## Probe (2026-11-20)

**The decision holds as written, with one rule for bytes:** `BASE64_DECODE` takes `varchar` and refuses `nvarchar` (error 8116), so the `OPENJSON … WITH` column of a base64 value must be `varchar(max)`.

Servers: Azure SQL Database (datahub BILLING), `Microsoft SQL Azure (RTM) - 12.0.2000.8`, EngineEdition 5; SQL Server 2025 in Docker, `17.0.5065.9`, EngineEdition 3. The client was `mssql` 12.7.4 from the elt checkout, Node.js 26.13.0, on a Mac, so the times of Azure include the network between the Mac and Azure. Each batch was one `sql.NVarChar(sql.MAX)` parameter. The tables were `#zz_elt_probe_*` tables of the session.

64 vectors of 1,536 dimensions, random float32 values from 1e-3 to 1e3, each the text of `toSql` of `@zukhruf/vectors/sqlserver`:

```text
batch: 1,293,444 characters (2.47 MiB as NVARCHAR)
SQL> INSERT INTO #zz_elt_probe_v (k, vector) SELECT j.k, CAST(j.v AS VECTOR(1536)) FROM OPENJSON(@batch) WITH (k int '$.k', v nvarchar(max) '$.v') AS j
  Azure SQL: rows 64, 941 ms        Docker: rows 64, 103 ms
SQL> SELECT TOP (1) CAST(vector AS varbinary(max)) AS bin FROM #zz_elt_probe_v
  ERROR 529 (state 1): Explicit conversion from data type vector to varbinary(max) is not allowed.
SQL> SELECT k, CAST(vector AS nvarchar(max)) AS text FROM #zz_elt_probe_v ORDER BY k
  Azure SQL: of 98304 values: 97942 parse back to the same float32, 362 differ only past the 8 significant digits that the text form prints, 0 differ
  Docker:    of 98304 values: 97957 parse back to the same float32, 347 differ only past the 8 significant digits that the text form prints, 0 differ
  text form of a row: [9.1485054e+001,-9.6341945e-002,7.7640951e-002,-...
SQL> SELECT CAST(N'[1,2,3]' AS VECTOR(1536)) AS wrong_dimensions
  ERROR 42204 (state 4): The vector dimensions 1536 and 3 do not match.
```

1,000 rows of text (`id`, `title` with non-ASCII letters, `body` of 512 base64 characters with `\u0000` and an emoji, `n bigint`, `at datetimeoffset(7)`), 629,671 characters:

```text
SQL> INSERT INTO #zz_elt_probe_text SELECT j.id, j.title, j.body, j.n, j.at FROM OPENJSON(@batch) WITH (id nvarchar(max) '$.id', title nvarchar(max) '$.title', body nvarchar(max) '$.body', n bigint '$.n', at datetimeoffset(7) '$.at') AS j
  Azure SQL: 308 ms, 378 ms, 297 ms (3 runs, round trip included)
  Docker:    33 ms, 31 ms, 30 ms
  row-7 title and body come back equal: true
```

Bytes, one file chunk of 4 MiB:

```text
SQL> SELECT BASE64_DECODE('AAEC/w==') AS small, BASE64_DECODE(N'AAEC/w==') AS from_nvarchar
  ERROR 8116 (state 1): Argument data type nvarchar is invalid for argument 1 of base64_decode function.
SQL> INSERT INTO #zz_elt_probe_files SELECT j.n, BASE64_DECODE(j.b) FROM OPENJSON(@batch) WITH (n bigint '$.n', b varchar(max) '$.b') AS j
  Azure SQL: 2099 ms        Docker: 227 ms
  stored 4194304 bytes; SHA-256 equal to the sent chunk: true   (both servers)
```

- `CAST(… AS VECTOR(1536))` of the `OPENJSON` text loads a batch of 64 vectors. No value read back differs from the value sent in the 8 significant digits that the text form of SQL Server prints. SQL Server does not convert a vector to `varbinary` (error 529), so the probe cannot compare all 9 digits on the server.
- A reader that reads a vector as text gets 8 significant digits. About 0.4% of float32 values do not come back to the same float32 from that text. The row hash does not see this, because it counts the JSON text of the stage.
- A vector of other dimensions fails with error 42204.
