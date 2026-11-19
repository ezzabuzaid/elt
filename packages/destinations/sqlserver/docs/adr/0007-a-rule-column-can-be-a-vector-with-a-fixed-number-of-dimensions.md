# A rule column can be a vector with a fixed number of dimensions

Status: accepted by Ezz (2026-11-19). This decision changes `@eltjs/elt`, `@eltjs/embedding`, elt-sqlite and elt-postgresql too.

The `Embedding` rule gives its vector as bytes: `toSql` of `@zukhruf/vectors/sqlite` writes float32 values, little-endian, into a `blob` column (`packages/embedding/src/embedding.ts`). `RuleColumn` of elt has two types, `text` and `blob`, "as SQLite stores it" (`packages/elt/src/core/rule.ts`). Thus the rule chooses the form of one store, and a destination sees only bytes.

Azure SQL can search a vector only in a `VECTOR(n)` column, and `VECTOR` converts only from text and JSON: "Conversion between vector and all other data types isn't allowed" ([vector data type](https://learn.microsoft.com/sql/t-sql/data-types/vector-data-type)). The dimensions are part of the type of the column, and the column must exist before the first row. Neither the destination nor the rule knows the dimensions today: an AI SDK embedding model does not say how many it gives.

This is a gap of elt's `Rule` port and of the `Embedding` rule, not of the destination: a rule column cannot say "a vector of n values", and the rule cannot say n.

The leaders:

| Tool                              | Where the dimensions come from                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pgai vectorizer                   | `ai.embedding_openai(model, dimensions, …)`: `dimensions` is required, "This should match the output dimensions of the chosen model" ([API reference](https://github.com/timescale/pgai/blob/main/docs/vectorizer/api-reference.md)) |
| Drizzle ORM, pgvector             | `vector({ dimensions })`, `vector(n)`: the column declares them                                                                                                                                                                      |
| EF Core, Microsoft.Data.SqlClient | `SqlVector<float>` with its length; the column is `vector(n)`                                                                                                                                                                        |
| Airbyte vector destinations       | the embedding configuration of the destination names the model and its dimensions                                                                                                                                                    |

## Decision

- `RuleColumn` gets a third kind: `{ type: 'vector'; dimensions: number; description: string }`. Its value is a `Vector` of `@zukhruf/vectors`. A `Vector` holds only finite float32 values and knows its dimensions, so a value with `NaN` or `Infinity` fails where the rule makes it, not in a search.
- Each destination writes a vector in its own form: SQLite as the bytes of `@zukhruf/vectors/sqlite`, as today; Postgres as `BYTEA` of the same bytes, as today; SQL Server as `VECTOR(n)` through the JSON text of `@zukhruf/vectors/sqlserver`. The rule no longer knows a store.
- `Embedding` takes `dimensions`, required, as pgai's vectorizer does. Its `output` is `{ vector: { type: 'vector', dimensions } }`. A vector of other dimensions than `dimensions` fails its row with an error that names both counts, and the next pass asks again, as a zero vector does now.
- The rule identity of `Embedding` is the provider, the id of the model and the dimensions, because one model can give different dimensions (the `dimensions` option of OpenAI's `text-embedding-3` models).
- A destination refuses a vector column that it cannot hold, in the constructor of `ComputedDataset`, with a `TypeError`: SQL Server holds at most 1,998 float32 dimensions.

## Considered Options

- **The destination finds the dimensions from the first vector.** The table must exist before the first row, and a refresh with no input would have no table.
- **The rule keeps bytes, and the SQL Server destination converts bytes of 4·n length to `VECTOR(n)`.** The destination would guess that a blob is a vector, and the rule would keep the form of SQLite.
- **A `VECTOR` column for SQL Server as `NVARCHAR(MAX)` JSON text.** Azure SQL could not search it without a cast of each row, and no vector index works on it.
- **A `Float32Array` as the value.** It holds `NaN` and `Infinity`: SQLite stores them with no error, and each distance to that row is then `NaN`. Each destination would convert it to a `Vector` before `toSql`.
- **A vector kind of rule column with its dimensions, a `Vector` as its value, and the form chosen by each destination.** This option was selected.

## Consequences

- `@eltjs/elt` takes `@zukhruf/vectors`, a package with no dependencies.
- A host that uses `Embedding` gives `dimensions`. For `text-embedding-3-small` it is 1,536.
- A change of `dimensions` changes the declaration of the raw table and the rule identity, so the dataset makes the table again and each vector again (elt-sqlite ADR 0004, elt ADR 0005).
- A model of more than 1,998 dimensions, such as `text-embedding-3-large` (3,072), needs a `float16` column in SQL Server: a later `HalfVector` kind.
- A gap of `@zukhruf/vectors`: `sqlType(vector)` takes a vector, and a column has only its dimensions. The package gives the type for a kind of vector and a count of dimensions, such as `sqlType(Vector, 1536)` (Ezz, 2026-11-19); the destination does not write `VECTOR(n)` itself.

Sources: backlog #4736, #4738, #4684; `@zukhruf/vectors` ADR 0007.
