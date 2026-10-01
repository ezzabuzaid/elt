# Duplication across the Apple hosts

Snapshot: 2026-10-01, after `apps/cli` landed beside the Codex plugin (`apps/apple/src/plugin`) and the Postgres exporter (`apps/apple/src/main.ts`, `pipeline.ts`, `warehouse-connection.ts`). The CLI was built on its own terms from the sources and elt, without importing host code, so that this inventory could be read off. It is the input for the refactor that follows; nothing here has been moved yet.

## Each host's audience

| Host | Users | Store | Runs |
| --- | --- | --- | --- |
| Plugin | ChatGPT desktop users, non-technical | `~/Library/Application Support/Context Compiler/Apple/<app>/<selection hash>/` | One leading MCP server per Mac, watching while Codex is open |
| CLI | Terminal users | `outputs/cli/<app>/` | `setup`, `sync [--watch]`, `status`, `query`, one store lock |
| Exporter | Developer warehouse | Postgres `apple_<app>` schemas, `marts` views | `apple:start`, watching until stopped |

Their different interfaces are intended: forms against prompts and flags, a settings page against a status table, Codex-sandbox `sqlite3 -readonly` against in-process reads. The duplication below is the rest.

## Same knowledge, written more than once

| Concern | CLI | Plugin | Exporter |
| --- | --- | --- | --- |
| App list and type | `apps/cli/src/main.ts` builds one `AppleApp` per app | `plugin/apps.ts` `appNames`; `plugin/settings.ts` zod enum | `pipeline.ts`, the seven `apple(...)` calls |
| Source per app, from a scope | `apps/<app>.ts` `source(scope)` | `plugin/apps.ts` `source(scope)` | `pipeline.ts`, unscoped constructors |
| Narrowing choices (streams, ids, labels) | `apps/<app>.ts` `choices`; builders in `apps/choice.ts` | `plugin/apps.ts` the same | — |
| Choice discovery read | `apps/apple-app.ts` `listChoices()` | `apple-plugin.ts` `options()` | — |
| Streams a narrowed import drops; store copies without bytes | `apps/<app>.ts` `unscoped`, `storeCopies` | `plugin/apps.ts` the same | — (unscoped, all files) |
| Calendar window | `apps/calendar.ts` 2000 → +1 year | `plugin/apps.ts` ±1 year | `pipeline.ts` 2000 → +1 year |
| Calendar remote attachments | off | off | Google Drive and Gmail |
| Permission guidance | `apps/<app>.ts` `access(terminal)`; `AppleApp.guidance()` names the launching app | `plugin/apps.ts` `permissions`, naming ChatGPT | README prose |
| Connection: raw tables, reader views, files, ids | `apps/apple-app.ts` `connection()` | `plugin/sync.ts` | `warehouse-connection.ts` (Postgres) |
| Reader view name rule `snake(stream)` | `apps/apple-app.ts` `view()` | `plugin/sync.ts` | `warehouse-connection.ts` |
| Copy ids | `<app>:<stream>` | `<app>:<stream>` | `apple-<app>:<stream>` |
| Selection model and validation | `store.ts` `Selection`; `commands/setup.ts` flag checks | `plugin/settings.ts` zod `configurationSchema` | — |
| Changed selection replaces the import | `store.ts` `select` | `plugin/settings.ts` `importDirectory`, `removeStaleImports` | — |
| One writer per store | `store.ts` `lock`, `busy` | `plugin/freshness.ts` `lease`, `leaderRunning` | — |
| History and catalog install, pipeline, watch loop | `sync.ts` | `plugin/freshness.ts` `watchImports` | `main.ts` |
| A connection that cannot be built reported per app | `sync.ts` | `plugin/freshness.ts` | — |
| Status from sync history | `commands/status.ts` | `apple-plugin.ts` `status()` | `marts.sync_status` |
| Relative time, scope wording | `commands/status.ts` `ago`; `AppleApp.describe()` | `native-settings.ts` `ago`, `coverage` | — |

Inside `apps/apple`, the `snake` rule was already written twice before the CLI (`plugin/sync.ts`, `warehouse-connection.ts`).

## Facts the hosts disagree on

- The Calendar window: ±1 year in the plugin, against everything since 2000 in the CLI and exporter.
- Copy ids: `apple-<app>:<stream>` in the exporter, against `<app>:<stream>` elsewhere.
- When an import is replaced: on any selection change (CLI, a folder per app), against a folder per selection hash (plugin). The CLI showed why it is needed: Notes' snapshot deletes already drop rows outside a new scope, but turning attachments off changes the load's checkpoint binding and fails the next sync unless the import is removed.

## Coming next

- The Apple Books connector (in progress) needs an entry in each host's registry: `plugin/apps.ts`, `pipeline.ts`, and an `AppleApp` subclass in `apps/cli/src/apps/`.
- A reader recovering a hot SQLite journal after an interrupted sync: the CLI's `Store.read` does it; the plugin's sandboxed readers cannot (backlog #2124).
