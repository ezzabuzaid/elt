# infra

The local services of the workspace, in `infra/docker-compose.yml`: the Postgres warehouse that the Google app loads, an optional MCP server that reads it as the reader role, and a SQL Server for the SQL Server source. The Postgres destination itself is in [elt-postgresql](../packages/destinations/postgresql/README.md).

## Commands

```sh
npx nx run infra:up               # start the warehouse and its MCP server
npx nx run infra:reset            # delete the volumes, then start again
npx nx run infra:down-warehouse   # stop the warehouse, keep SQL Server running
npx nx run infra:up-sqlserver     # start SQL Server (profile sqlserver)
npx nx run infra:down-sqlserver   # stop SQL Server
npx nx run infra:down             # stop and remove all services
```

| Service         | Image                                                       | Port              |
| --------------- | ----------------------------------------------------------- | ----------------- |
| `warehouse`     | `postgres:18`                                               | `127.0.0.1:55432` |
| `warehouse-mcp` | `crystaldba/postgres-mcp:0.3.0`                             | `127.0.0.1:8000`  |
| `sqlserver`     | `mcr.microsoft.com/mssql/server:2022-latest`, `linux/amd64` | `127.0.0.1:51433` |

Microsoft publishes the SQL Server image only for amd64, so on Apple silicon it runs emulated. It is in the `sqlserver` profile, so `infra:up` starts only the warehouse.

## The warehouse

The Google app loads into the `warehouse` database. Its pipeline installs the sync history views and `catalog` in `marts`. Each copy keeps a reader view of its raw table in `marts`, named after the source and the stream.

```text
warehouse database
├── google_search_console   raw tables and _elt_checkpoints, loaded by elt-postgresql; readers have no access
├── google_health           raw tables and _elt_checkpoints of Google Health; readers have no access
├── _warehouse              private sync attempts, coverage declarations and stream checks
├── marts                   documented reader views, one prefix per source
└── public                  revoked from PUBLIC
roles: warehouse (loads, owns the database) · agent_reader (reads marts only)
```

### Roles and privileges

The privileges are the barrier.

- `warehouse` logs in, owns the `warehouse` database, loads the raw schemas and publishes `marts`.
- `agent_reader` has `CONNECT` on the database, `USAGE` on `marts` and `SELECT` on its relations, and nothing else. It has no `TEMP`, no `CREATE`, and no access to the raw schemas. Views run with the rights of their owner.
- `agent_reader` is `NOINHERIT`, with a limit of 5 connections.
- The settings of `agent_reader` are only defaults, because a session can change them: `default_transaction_read_only = on`, `statement_timeout = 30s`, `idle_in_transaction_session_timeout = 60s` and `search_path = marts`.

### The init scripts

The Postgres image runs the scripts in `infra/init` one time, when it makes the volume:

- `01-roles.sh` makes the roles `warehouse` and `agent_reader` and the database `warehouse`, in the `postgres` database. It reads the passwords from `WAREHOUSE_PASSWORD` and `AGENT_PASSWORD`.
- `02-marts.sh` runs `infra/init/marts/contract.sql` in the `warehouse` database. The contract revokes `PUBLIC` access to the database and to `public`, gives `agent_reader` `CONNECT`, makes `marts` owned by `warehouse`, gives `agent_reader` `USAGE` on `marts`, and sets default privileges so that each table and view that the `warehouse` role makes in `marts` is readable by `agent_reader`.
- No application code grants access.
- To apply a changed contract, make the volume again with `npx nx run infra:reset`.
- `PostgresSyncHistory` publishes `catalog` when the pipeline installs it. elt-postgresql makes each reader view with its table, at the first commit of the stream. A later commit does not replace it.

### Read the warehouse

- Use `psql` as `agent_reader`. MCP is optional.
- The explicitly invoked `query-warehouse` consumer finds the relations and their meanings in `marts.catalog`. It reads connected data only on request. It does not run pipelines, refresh data or manage connectors.
- The optional MCP server holds the password of the reader, runs each statement in a read-only transaction, refuses statements that would end it, and cancels each statement past 30 seconds. Version 0.3.0 is pinned, and it serves stdio or SSE only.
- The sync history relations and how to judge freshness are in [elt-postgresql](../packages/destinations/postgresql/README.md#sync-history).

### Live checks

Checked on 2026-09-24 against Postgres 18.3, first on a local Homebrew server. A run as the roles `warehouse` and `agent_reader` (not superusers), with reads through `postgres-mcp` 0.3.0 in restricted mode, showed three things:

- Raw schemas answer `permission denied`.
- `COMMIT; CREATE TABLE …` fails validation.
- A count of three billion rows is cancelled after 30 seconds.

Then the compose stack started on Docker Desktop 4.92.0. The init scripts made the two roles and the database, the `elt-postgresql` tests passed against it, and the MCP container answered as `agent_reader` with `search_path` `marts`: it refused `pg_authid`, refused a `COMMIT;` escape, and cancelled a long count at 30 seconds. A live load of `sc-domain:ezz.sh` into the compose warehouse then filled each view.
