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
