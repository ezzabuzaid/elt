# A change of a table makes the views over it again

Postgres binds a view to the relations that it read when it was made, by their OID. Thus `DROP TABLE`, `ALTER COLUMN … TYPE`, `DROP COLUMN` and `DROP VIEW` fail with `2BP01` while a view reads the relation. The swap of a reload, a change of shape and the replace of a view are such changes. Each loaded table is in `_warehouse`, and its reader view and the views over it are in `marts` (ADR 0010). Before this decision, one view that a person or an agent made over a loaded table or its reader view stopped each such change of that table (backlog #3185). SQLite has no such failure, because its views find their tables by name at each read.

elt makes and changes only what it declared. It must not delete what it did not make, and it must not stop on it.

Thus each such change runs in one transaction with the views that read the table, its history or its reader view, directly or through other views. Before the change, the destination saves each of these views: its definition with each name qualified, its options, the indexes of a materialized view, its owner, its comments and its privileges. Then it drops them, the deepest first. After the change, it makes them again over the relations that have the names that they read, the shallowest first, and gives back each saved fact. The relations that the change makes again, a swapped-in table and its reader view, keep the privileges of the relations whose names they take, as Snowflake's `COPY GRANTS` keeps them. A privilege that default privileges give a new relation, and that the old one did not have, is revoked.

## Considered Options

The leading tools, from their source:

- **Drop with `CASCADE`, and make again only the tool's own views.** dbt-postgres renames the old table to a backup and drops it with `cascade` (`dbt-postgres` `relations/table/drop.sql`). SQLMesh drops a view of its virtual layer with `cascade=True` (`base_postgres.py`). A view that the tool did not declare is gone, silently.
- **Fail, with an opt-in `CASCADE`.** Airbyte destination-postgres (`dropCascade`, default `false`, "Risk of unrecoverable data loss") and its `2BP01` advice. Estuary and Meltano also fail. One foreign view stops every reload.
- **Late binding.** Snowflake and BigQuery views, and Redshift views `WITH NO SCHEMA BINDING`, find their tables by name at each query. Postgres has no late binding.
- **Save, drop and make again, in one transaction.** pg-deps-management (`deps_save_and_drop_dependencies` and `deps_restore_dependencies`), which many projects copy. It keeps each view, its owner, comments and grants. This is the nearest Postgres can come to late binding. This option was selected.

## Consequences

- A view in `marts` over a loaded table in `_warehouse`, its history or its reader view, by elt or by another role, reads the new table after a reload or a change of shape, with the same owner, options, comments and privileges. A materialized view is made again `WITH DATA`, with its indexes.
- A view that does not fit the change, such as a view that reads a column that the change drops, fails the change. The error names the view. The table, the views and the checkpoint stay as they were, and the copy fails until the view changes or someone drops it.
- An object of another kind that depends on such a view, such as a function with a SQL-standard body, fails the change. The error names the view.
- Readers of these views wait for the change, as they wait for the swap, at most 3 seconds.

Sources: #3185; dbt-labs/dbt-adapters 354d113a; airbytehq/airbyte f5cbf0fd (`PostgresSpecification.kt`, `PostgresDirectLoadSqlGenerator.kt`, `PostgresAirbyteClient.kt`); TobikoData/sqlmesh 54852e7c; rvkulikov/pg-deps-management 839315109.
