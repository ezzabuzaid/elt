# A host names each relation that readers query once

Status: proposed. Ezz chose this rule on 2026-11-19. The text waits for review before any code (backlog #4886).

The readers of a destination are agents and eca rules. They find the data through `catalog`, they read the columns of the external schema, and they read the destination as of a position. Before this decision, the host gave the target of a copy two names: the raw table, such as `raw_notes`, and, when it called `withReaderView`, its reader view, such as `notes`. The reader view was optional. A target with no reader view was not in `catalog`, showed the internal columns `committed_in` and `_elt_row_hash`, and in Postgres did not read as of a position, because only the reader view reads the history of the target. eca reads the whole warehouse as of one position, so such a target gave a rule a wrong reading. A computed dataset already took one name, `<name>`: its destination made the raw table `raw_<name>` and the view `<name>`. Thus the kinds of relation answered one question, "where does a reader find this?", in two ways.

The tools that load data or derive it are in two families:

- **Loaders give readers the physical table.** The Postgres destination of Airbyte writes one table for each stream, with `_airbyte_raw_id`, `_airbyte_extracted_at`, `_airbyte_meta` and `_airbyte_generation_id` in it. It makes no view and writes no comment. Fivetran adds `_fivetran_synced` and `_fivetran_deleted`. Its history mode keeps the old versions in the same table, and the reader writes `WHERE t BETWEEN _fivetran_start AND _fivetran_end`. Estuary and the `target-postgres` of Singer also give the table. Only Estuary writes comments, from the JSON Schema.
- **Transformation tools keep a virtual layer of views over a physical layer of tables.** In SQLMesh, the user names only the model, such as `finance_mart.events`. SQLMesh keeps the table in `sqlmesh__finance_mart.finance_mart__events__<fingerprint>` and makes the view `SELECT *` with the comments of the model. A staging model of dbt is one view for each source table. It renames, casts and describes.

elt is in both families: it loads, and it keeps derived datasets. Its readers are agents. Postgres has no time travel: system-versioned tables (SQL:2011, T180) are an unsupported feature. Thus a reading as of a position needs a view over the table and its history. A reader that writes that filter does the work that the system must do.

Thus a host names each relation that readers query once, and the destination always makes it as a view: the reader view of the target of a copy, the view of a `View`, and the view of a computed dataset. The destination keeps each physical table, its history and its file tables under names that it picks, where readers do not look. `withReaderView` goes. The commits of a target make, change and drop its reader view in the same transaction, as the writers do now. The stream of each copy, and each field of it, must have a JSON Schema description. A copy that lacks one fails at declaration and names each missing description.

## Considered Options

- **Two names and an optional reader view.** A target with no reader view is not in `catalog`, shows the internal columns and does not read as of a position.
- **Readers read the physical table, as the loaders do.** Readers then see `committed_in` and `_elt_row_hash`, and in Postgres each reader writes the filter of the history.
- **A `View` in `derived` for each copy.** The host writes the SQL, the description and the columns of each stream again. A refresh runs after the commit, not in it. A Postgres `View` that reads a column that a change drops stops the change (ADR 0006 of elt-postgresql). The host cannot read the history of a target.
- **One name, and the destination keeps the physical layer.** This option was selected.

## Consequences

- `SQLiteTable` and `PostgresTable` take the reader name, such as `destination.table('notes')`. They have no `withReaderView` and no field that is `undefined` when a target has no view.
- Each destination places its physical tables: elt-sqlite in the same file as the views (ADR 0010 of elt-sqlite), and elt-postgresql in `_warehouse`, with the views in `marts` (ADR 0010 of elt-postgresql).
- `catalog` lists the target of each copy, because each target has a view.
- A `View` and a computed dataset read reader views only. The check of names compares reader names only.
- Each host that loaded a table with no reader view must describe each field of its streams. In context-compiler, these are startup-credits, ipay, websets, logful and what-is-going-on.
- A reader that reads `marts.<name>` or a SQLite reader view sees the same names.
- The stored layout changes, and a new run makes it, because stored data is disposable. The change breaks the API of `@eltjs/elt-sqlite` and `@eltjs/elt-postgresql`.

Sources: #4886; airbytehq/airbyte f5cbf0fd (`PostgresDirectLoadSqlGenerator.kt`, `PostgresColumnManager.kt`); TobikoData/sqlmesh 54852e7c (`sqlmesh/core/snapshot/evaluator.py`, `PromotableStrategy.promote`; `docs/guides/configuration.md`); docs.getdbt.com, "How we structure our dbt projects", staging; fivetran.com/docs, "System columns and tables" and "History mode"; estuary/connectors 5385f05c (`materialize-postgres/sqlgen.go`); postgresql.org/docs/current/unsupported-features-sql-standard.html.
