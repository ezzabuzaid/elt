# Readers look in marts, and elt keeps its tables in _warehouse

Status: accepted by Ezz (2026-11-19). Backlog #4886.

Before this decision, a warehouse had three kinds of schema:

- `marts` held `catalog` and the views of the sync history, which `PostgresSyncHistory.install()` publishes there. It also held the reader views, which each host put there with `withReaderView('marts', name)`. The catalog listed only the views of `marts`, so it did not show a reader view in another schema.
- `_warehouse` held the tables of the sync history, `derived_status` and the numbering of the commits.
- The schema of each `PostgresDestination`, such as `apple_messages`, held the raw tables, their histories, their file tables, the checkpoints and the writers.

On 2026-09-29, Ezz chose one shared schema for readers and a private raw schema for each source. ADR 0028 of elt now lets a host name only the relation that readers query. Thus a host has no reason to name a second schema: elt places what readers do not read. The loaders also fix such a schema. Airbyte keeps its raw tables in `airbyte_internal`, and Fivetran keeps its logs in `fivetran_metadata`. SQLMesh derives `sqlmesh__<schema>` from the schema of the user. A Postgres view reads its tables with the rights of its owner. Thus `agent_reader`, which can use only `marts` (`infra/init/marts/contract.sql`), reads each view and cannot open `_warehouse`.

Thus a warehouse has two schemas, and elt-postgresql fixes both. Each relation that readers query is a view in `marts`, and each table of elt is in `_warehouse`. A host names the database and each reader relation: `new PostgresDestination({ url }).table('messages_messages')` makes `marts.messages_messages` and `_warehouse.raw_messages_messages`. `new PostgresCheckpointStore({ url })` keeps `_warehouse._elt_checkpoints`, whose key is the id of the copy. No schema is kept for each connector.

## Considered Options

- **A schema for each connector, and `marts` for readers.** A host names two schemas, and the catalog does not show a reader view outside `marts`.
- **The host names the schema of the readers**, such as `new PostgresDestination({ url, schema: 'marts' })`. The catalog and the views of the sync history must then follow the schema of each destination, and each host gives `marts`.
- **Two fixed schemas.** This option was selected. It completes ADR 0005, which put the catalog in `marts` because the two hosts named only `marts`.

## Consequences

- `PostgresDestination` and `PostgresCheckpointStore` take no schema.
- Names cannot collide in `_warehouse`. The name of each raw table comes from a reader name, and each reader name is unique in `marts`. History tables and file tables keep their hash names. A target still has one writer (ADR 0008 of elt).
- A reader name cannot be the name of a view that elt publishes in `marts`, such as `catalog` or `sync_status`.
- `stream_status` and `extraction_coverage` show the reader view: `target_schema` is `marts`, `target_table` is the reader name, and `target_exists` tells whether that view exists.
- The file table of a stored-file column gets a view in `marts` under its hash name. The description of the column names that view, so `agent_reader` can read the bytes. No Postgres host stores files yet.
- A connector cannot be reset by dropping its schema. A clear forgets the rows that it removes (ADR 0023 of elt), and `nx run infra:reset` resets the warehouse.
- ADR 0006 still applies: a change of a table in `_warehouse` makes the views over it in `marts` again.
- This decision replaces the private raw schema for each source of 2026-09-29.

Sources: #4886; ADR 0005; ADR 0028 of elt; airbytehq/airbyte f5cbf0fd (`PostgresTableSchemaMapper.kt`, `docs/platform/using-airbyte/core-concepts/typing-deduping.md`); fivetran.com/docs/logs/fivetran-platform; TobikoData/sqlmesh 54852e7c (`docs/guides/configuration.md`).
