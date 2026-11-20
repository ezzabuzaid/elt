# A change of a table refreshes the views over it

Status: accepted by Ezz (2026-11-19).

elt-postgresql ADR 0006 saves, drops and makes again each view over a table that a change replaces, because Postgres binds a view to the OID of its tables and refuses `DROP TABLE` while a view reads it. SQLite finds the tables of a view by name at each read, so it needs nothing.

SQL Server is close to SQLite. A view without `SCHEMABINDING` finds its tables by name when SQL Server compiles a query on it, so a table can be dropped, renamed or changed under it. But SQL Server keeps the column list of the view as it was made, so a view that selects `*` shows the old columns until `sp_refreshview` reads its definition again ([sp_refreshview](https://learn.microsoft.com/sql/relational-databases/system-stored-procedures/sp-refreshview-transact-sql)). A view `WITH SCHEMABINDING` refuses a rename or a drop of a table that it reads, and a change or a drop of a column that it reads. An added column, or a change of a column that it does not read, goes through (probe below).

## Decision

- In the transaction of a change of shape or of the swap of a reload, the destination finds each view that reads the table, its history or its reader view, directly or through other views (`sys.sql_expression_dependencies`), and runs `sp_refreshview` on each one, the shallowest first.
- A view that does not fit the change, such as one that reads a column that the change drops, fails `sp_refreshview`. The change then fails, the error names the view, and the table and the checkpoint stay as they were, as in Postgres.
- A change that a view `WITH SCHEMABINDING` stops (error 15336, 3729 or 4922) fails, and the table and the checkpoint stay as they were. The server's error names the table or the column, so the destination catches it and names in its own error each schema-bound view of the table (`is_schema_bound_reference` of `sys.sql_expression_dependencies`). It does not look for such views before the change: the change itself is the test, and a change that such a view allows, such as an added column, goes through.
- The views keep their owners, grants and extended properties, because nothing drops them. A swapped-in table takes the grants of the old table.

## Considered Options

- **A port of elt-postgresql ADR 0006: save, drop, and make again.** SQL Server does not need it, and each make would lose what the save does not know.
- **Nothing.** A view over `*` then shows the old columns.
- **`sp_refreshview` for each dependent view.** This option was selected.

## Consequences

- A view that a person or an agent made over a reader view reads the new table after a reload, with its grants.
- To probe before code: `sp_rename` of a table that a view reads, then `sp_refreshview`; and the error number of a `SCHEMABINDING` view.

Sources: elt-postgresql ADR 0006; backlog #3185.

## Probe (2026-11-20): `sp_rename`, `sp_refreshview` and `SCHEMABINDING`

**The refresh holds as written. The `SCHEMABINDING` part corrected the decision (2026-11-20): the server stops only some changes, and the destination names the schema-bound views in its own error.** A view `WITH SCHEMABINDING` stops a swap, a drop, and a change or drop of a column that it reads. It does not stop `ADD` of a column, or `ALTER COLUMN` of a column that it does not read. Two of the three errors do not name the view.

Servers: Azure SQL Database (datahub BILLING), `Microsoft SQL Azure (RTM) - 12.0.2000.8`, EngineEdition 5; SQL Server 2025 in Docker, `17.0.5065.9`, EngineEdition 3. Both gave the same output, except object ids. The objects were `dbo.zz_elt_probe_*` tables and views, dropped at the end.

```text
SQL> CREATE TABLE dbo.zz_elt_probe_t (id int NOT NULL, a nvarchar(10)); INSERT ... VALUES (1, N'old');
SQL> CREATE VIEW dbo.zz_elt_probe_v AS SELECT * FROM dbo.zz_elt_probe_t
SQL> CREATE VIEW dbo.zz_elt_probe_v2 AS SELECT * FROM dbo.zz_elt_probe_v
SQL> CREATE VIEW dbo.zz_elt_probe_va AS SELECT id, a FROM dbo.zz_elt_probe_t
SQL> SELECT OBJECT_NAME(d.referencing_id) AS view_name, d.referenced_entity_name, d.referenced_id FROM sys.sql_expression_dependencies d ...
  {"view_name":"zz_elt_probe_v","referenced_entity_name":"zz_elt_probe_t","referenced_id":1887397843}
  {"view_name":"zz_elt_probe_v2","referenced_entity_name":"zz_elt_probe_v","referenced_id":1903397900}
  {"view_name":"zz_elt_probe_va","referenced_entity_name":"zz_elt_probe_t","referenced_id":1887397843}
SQL> CREATE TABLE dbo.zz_elt_probe_next (id int NOT NULL, a nvarchar(10), b nvarchar(10)); INSERT ... VALUES (2, N'new', N'added');
SQL> SET LOCK_TIMEOUT 3000; BEGIN TRAN;
     EXEC sp_rename N'dbo.zz_elt_probe_t', N'zz_elt_probe_old';
     EXEC sp_rename N'dbo.zz_elt_probe_next', N'zz_elt_probe_t';
     SELECT ... FROM dbo.zz_elt_probe_v; SELECT ... FROM dbo.zz_elt_probe_v2;
     EXEC sp_refreshview N'dbo.zz_elt_probe_v'; SELECT ... (v, v2);
     EXEC sp_refreshview N'dbo.zz_elt_probe_v2'; SELECT ... (v2);
     COMMIT;
  info 15477: Caution: Changing any part of an object name could break scripts and stored procedures.
  info 15477: Caution: Changing any part of an object name could break scripts and stored procedures.
  {"step":"v before refresh","id":2,"a":"new"}
  {"step":"v2 before refresh","id":2,"a":"new"}
  {"step":"v after refresh of v","id":2,"a":"new","b":"added"}
  {"step":"v2 after refresh of v","id":2,"a":"new"}
  {"step":"v2 after refresh of v2","id":2,"a":"new","b":"added"}
SQL> (the dependencies again)
  {"view_name":"zz_elt_probe_v","referenced_entity_name":"zz_elt_probe_t","referenced_id":1951398071}
  {"view_name":"zz_elt_probe_v2","referenced_entity_name":"zz_elt_probe_v","referenced_id":1903397900}
  {"view_name":"zz_elt_probe_va","referenced_entity_name":"zz_elt_probe_t","referenced_id":1951398071}
SQL> ALTER TABLE dbo.zz_elt_probe_t DROP COLUMN a
SQL> BEGIN TRAN; EXEC sp_refreshview N'dbo.zz_elt_probe_va'; COMMIT;
  ERROR 207 (state 1): Invalid column name 'a'.
SQL> SELECT @@TRANCOUNT AS trancount_after_error
  {"trancount_after_error":0}
SQL> CREATE VIEW dbo.zz_elt_probe_sb WITH SCHEMABINDING AS SELECT id, a FROM dbo.zz_elt_probe_t   (after a was added again)
SQL> EXEC sp_rename N'dbo.zz_elt_probe_t', N'zz_elt_probe_t2'
  ERROR 15336 (state 1): Object 'dbo.zz_elt_probe_t' cannot be renamed because the object participates in enforced dependencies.
SQL> DROP TABLE dbo.zz_elt_probe_t
  ERROR 3729 (state 1): Cannot DROP TABLE 'dbo.zz_elt_probe_t' because it is being referenced by object 'zz_elt_probe_sb'.
SQL> ALTER TABLE dbo.zz_elt_probe_t ALTER COLUMN a nvarchar(20)
  ERROR 4922 (state 9): ALTER TABLE ALTER COLUMN a failed because one or more objects access this column.
SQL> ALTER TABLE dbo.zz_elt_probe_t DROP COLUMN a
  ERROR 4922 (state 9): ALTER TABLE DROP COLUMN a failed because one or more objects access this column.
SQL> ALTER TABLE dbo.zz_elt_probe_t ALTER COLUMN b nvarchar(20)
SQL> ALTER TABLE dbo.zz_elt_probe_t ADD c int
SQL> SELECT OBJECT_NAME(d.referencing_id) AS view_name, OBJECTPROPERTY(d.referencing_id, 'IsSchemaBound') AS is_schema_bound, d.is_schema_bound_reference FROM sys.sql_expression_dependencies d WHERE d.referenced_id = OBJECT_ID('dbo.zz_elt_probe_t')
  {"view_name":"zz_elt_probe_sb","is_schema_bound":1,"is_schema_bound_reference":true}   (one row for each column it reads, and one for the table)
  {"view_name":"zz_elt_probe_v","is_schema_bound":0,"is_schema_bound_reference":false}
  {"view_name":"zz_elt_probe_va","is_schema_bound":0,"is_schema_bound_reference":false}
```

- After the swap, a view over `*` shows the old columns until `sp_refreshview`. A view over that view needs its own refresh after it, so the order shallowest first is necessary.
- `sys.sql_expression_dependencies` gives the new table's id after the swap, because SQL Server keeps the dependency by name. Thus the destination finds the dependent views of the swapped-in table.
- A view that reads a dropped column fails `sp_refreshview` with error 207, which names the column and not the view. The error ends the transaction (`@@TRANCOUNT` is 0), so the change does not stay. The destination must name the view in its own error.
- The decision first said that a view `WITH SCHEMABINDING` stops each change. The server refuses the swap (15336, names the table), a drop (3729, names the view) and a change of a column that the view reads (4922, names the column). It lets `ADD c` and `ALTER COLUMN b` go through. `is_schema_bound_reference` of `sys.sql_expression_dependencies` tells which views are schema-bound, so the destination names them; the decision now says so (2026-11-20).

## Probe (2026-11-20): a bare table name inside a view

This probe is for the README, "Declare a view": "SQL Server resolves a bare name inside a view through the schema of the view and then `dbo` (to probe; if the probe shows the default schema of the user, the destination refuses a bare name at the declaration)".

**The README holds as written: the schema of the view, then `dbo`. The default schema of the user takes no part, so the destination need not refuse a bare name.**

Servers: as above. Ezz's ruling lets the probe make only `zz_elt_probe_*` objects in BILLING, so `zz_elt_probe_marts` stands for `marts`. The login's default schema on Azure SQL is `dbo`, and no user was made there. The user with another default schema (`CREATE USER zz_elt_probe_user WITHOUT LOGIN WITH DEFAULT_SCHEMA = zz_elt_probe_other`, `EXECUTE AS USER`) ran in Docker only.

```text
SQL> SELECT SCHEMA_NAME() AS default_schema_of_the_login
  {"default_schema_of_the_login":"dbo"}                         (both servers)
SQL> CREATE TABLE zz_elt_probe_marts.zz_elt_probe_n (src nvarchar(40)); INSERT ... (N'the schema of the view');
     CREATE TABLE dbo.zz_elt_probe_n (src nvarchar(40)); INSERT ... (N'dbo');
     CREATE TABLE zz_elt_probe_other.zz_elt_probe_n (src nvarchar(40)); INSERT ... (N'the default schema of the user');
SQL> CREATE VIEW zz_elt_probe_marts.zz_elt_probe_view AS SELECT src FROM zz_elt_probe_n
SQL> SELECT referenced_schema_name, referenced_entity_name, OBJECT_SCHEMA_NAME(referenced_id) AS bound_schema_now, is_caller_dependent FROM sys.sql_expression_dependencies WHERE referencing_id = OBJECT_ID('zz_elt_probe_marts.zz_elt_probe_view')
  {"referenced_schema_name":null,"referenced_entity_name":"zz_elt_probe_n","bound_schema_now":"zz_elt_probe_marts","is_caller_dependent":false}

-- a table of that name in the schema of the view, in dbo and in the default schema of the user
  Azure SQL, login (default dbo):              {"resolves_to":"the schema of the view"}
  Docker, sa (default dbo):                    {"resolves_to":"the schema of the view"}
  Docker, zz_elt_probe_user (default other):   {"resolves_to":"the schema of the view"}
SQL> DROP TABLE zz_elt_probe_marts.zz_elt_probe_n
-- no table of that name in the schema of the view
  Azure SQL, login:                            {"resolves_to":"dbo"}
  Docker, sa:                                  {"resolves_to":"dbo"}
  Docker, zz_elt_probe_user:                   {"resolves_to":"dbo"}
SQL> DROP TABLE dbo.zz_elt_probe_n
-- the table only in the default schema of the user
  Azure SQL, login:            ERROR 4413 (state 1): Could not use view or function 'zz_elt_probe_marts.zz_elt_probe_view' because of binding errors.
  Docker, sa:                  ERROR 4413 (state 1): (the same)
  Docker, zz_elt_probe_user:   ERROR 4413 (state 1): (the same)
-- CREATE VIEW in the schema of the view with a bare name found only in dbo
SQL> CREATE VIEW zz_elt_probe_marts.zz_elt_probe_view_d AS SELECT src FROM zz_elt_probe_d; SELECT src FROM zz_elt_probe_marts.zz_elt_probe_view_d;
  {"resolves_to":"dbo"}                                         (both servers)
-- CREATE VIEW over a name that no schema has
SQL> CREATE VIEW dbo.zz_elt_probe_missing AS SELECT src FROM zz_elt_probe_nothing
  ERROR 208 (state 1): Invalid object name 'zz_elt_probe_nothing'.   (both servers)
```

- A bare name inside a view finds the schema of the view first, then `dbo`, for every user. `is_caller_dependent` is 0.
- A bare name that is not in the schema of the view finds a `dbo` table of that name, at `CREATE VIEW` and at each read. The SQL of a view must name a relation of another schema with its schema, as the README says, or it can read a `dbo` table.
- A relation that is missing at `CREATE VIEW` is error 208. A relation that goes away after the view was made fails a read of the view with error 4413, not 208.
