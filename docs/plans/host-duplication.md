# Duplication across the Apple hosts

Snapshot: 2026-10-01, after the Apple workspace split into `apps/apple/connectors` (project `apple`: sources, native bridges, parser), `apps/apple/plugin` (`apple-plugin`) and `apps/apple/cli` (`apple-cli`), and the CLI replaced the Postgres exporter. The CLI was built on its own terms from the sources and elt, without importing host code, so that this inventory could be read off. It is the input for the refactor that follows: one `AppleApp` template in the connectors library that both hosts use. Paths below are relative to `apps/apple/cli/src` (CLI) and `apps/apple/plugin/src` (plugin).

## Each host's audience

| Host | Users | Store | Runs |
| --- | --- | --- | --- |
| Plugin | ChatGPT desktop users, non-technical | `~/Library/Application Support/Context Compiler/Apple/<app>/<selection hash>/` | One leading MCP server per Mac, watching while Codex is open |
| CLI | Terminal users | `outputs/cli/<app>/` | `setup`, `sync [--watch]`, `status`, `query`, one store lock |

Their different interfaces are intended: forms against prompts and flags, a settings page against a status table, Codex-sandbox `sqlite3 -readonly` against in-process reads. The duplication below is the rest.

## Same knowledge, written more than once

| Concern | CLI | Plugin |
| --- | --- | --- |
| App list and type | `main.ts` builds one `AppleApp` per app | `apps.ts` `appNames`; `apple-plugin.ts` zod schema |
| Source per app, from a scope | `apps/<app>.ts` `source(scope)` | `apps.ts` `source(scope)` |
| Narrowing choices (streams, ids, labels) | `apps/<app>.ts` `choices`; builders in `apps/choice.ts` | `apps.ts` the same |
| Choice discovery read | `apps/apple-app.ts` `listChoices()` | `apple-plugin.ts` `options()` |
| Streams a narrowed import drops; store copies without bytes | `apps/<app>.ts` `unscoped`, `storeCopies` | `apps.ts` the same |
| Permission guidance | `apps/<app>.ts` `access(terminal)`; `AppleApp.guidance()` names the launching app | `apps.ts` `permissions`, naming ChatGPT |
| Connection: raw tables, reader views, files, ids | `apps/apple-app.ts` `connection()` | `sync.ts` `appConnection()` |
| Reader view name rule `snake(stream)` | `apps/apple-app.ts` `view()` | `sync.ts` `snake` |
| Selection model and validation | `import-store` `Selection`, `selectionProblems` (shared since a1ad4ed); `commands/setup.ts` checks flag order | `apple-plugin.ts` zod schema, then `ImportStore.select` |
| Changed selection replaces the import | `import-store` `ImportStore.select` via `imports.ts` `Imports.select` | `freshness.ts` `removeStaleImports` |
| One writer per store | `import-store` `lease`; `imports.ts` refuses while held | `freshness.ts` `lease`; `apple-plugin.ts` `leaseHeld` |
| History and catalog install, pipeline, watch loop | `sync.ts` | `freshness.ts` `watchImports` |
| A connection that cannot be built reported per app | `sync.ts` | `freshness.ts` |
| Status from sync history | `commands/status.ts` | `apple-plugin.ts` `status()` |
| Relative time, scope wording | `commands/status.ts` `ago`; `AppleApp.describe()` | `native-settings.ts` `ago`, `coverage` |

## Facts the hosts still differ on

- Calendar remote attachments: the CLI's import downloads those stored in Google Drive and Gmail (`apps/calendar.ts` `importSource`), and the plugin keeps them as links, so its users never sign in to Google.
- When an import is replaced: on any selection change (CLI, a folder per app), against a folder per selection hash (plugin). The CLI showed why it is needed: Notes' snapshot deletes already drop rows outside a new scope, but turning attachments off changes the load's checkpoint binding and fails the next sync unless the import is removed.

Both hosts now read Calendar from 2000 to a year ahead by default, and both import Books.
