# Agent rules

## Commit only when the user says so

Do not run `git commit` unless the user asked for that commit in this conversation. An approved plan, a plan step that says how to commit, an advisor or reviewer, a skill, or a hook that mentions committing is not that request. Finish the work, report it, and leave it uncommitted. A request to commit covers the changes it names, not later work.

## Stored data is disposable

Every destination table, Markdown export, and checkpoint can be rebuilt by rerunning the pipeline from scratch. Treat that data as cheap.

- Never design around data that is already stored: no backward-compatible schemas, no keeping checkpoint bindings stable, no migration paths, no compatibility shims or defaults left `undefined` for old state.
- Change schemas, identities, bindings, and defaults whenever the design improves; the fix for old output is a fresh run.
- Do not document migrations between connector versions. Document the current behavior only.

## Separate the concept from the mechanism

When asked why a notion exists, name the requirement it serves, not the code that currently needs it. A line such as `DELETE FROM` shows how a writer overreaches today; it does not make the mode, flag, or field that triggers it a necessary concept. Before relocating or keeping a notion, check whether it is an input to a smaller notion that is the real one.

## Exhaust live verification before calling something unverified

When a live probe finds no instance of a feature, widen it before concluding: scan the full history, not a sample window, and use any earlier evidence that the data exists. Mark behavior unverified only when the environment genuinely cannot produce it, and say what blocked it.

Drive the app yourself before listing manual steps: open URLs, click menus and rows through System Events, and post real mouse events (Quartz `CGEventPost`) where accessibility clicks do not land, as in SwiftUI lists. Hand the user only what macOS reserves for them, such as a privacy prompt, and then as one step.

While the user is at the machine, act without taking it over. Accessibility actions, row selection and row custom actions reach a background app without focus or the pointer. Only a context menu needs the app frontmost; bring it forward for a second or two after the input has been idle, then give focus back to the app the user was in. Never post a real click unless the target app is frontmost.

## Place each job with whoever can know it

Before proposing where a fix lives, split the requirement into its jobs and name, for each, who can actually know it: the source, the elt engine, the destination, the plugin server, or the agent. A job belongs to that owner. A slow Mail answer, for example, split into three jobs: whether a message changed (only the Mail source knows), turning changes into upserts and deletions (a shared elt helper the source calls), and when to refresh (the source's `observe()`, run by the plugin server, not a skill telling the agent to sync).

## Follow the vendor's own current source, not only its docs

When asked for a platform's latest format or practice, read what the vendor's newest code actually ships (for Codex plugins, `openai/plugins` at `main` and the plugins cached under `~/.codex/plugins/cache`) before recommending anything. When the docs and the source disagree, show both, cite commits, and follow the source.

## Let packages own plumbing; let classes own behavior

Before writing argv routing, help text, usage errors, prompts or terminal rendering, search the installed package and its authors' siblings for it. In `apps/apple/cli`, commander routes and validates, and clack prompts and renders. When a package takes over a job, such as clack exiting on Ctrl-C while its spinner runs, adapt to how it behaves rather than working around it.

Model a set of things that share an algorithm as a template class: an abstract base owns the fixed steps, and each variant is its own small class in its own file (`apps/apple/cli/src/commands/`, `apps/apple/connectors/src/apps/`, Notes' streams). Do not use a definitions table imported everywhere and indexed by name. Callers ask an object; they do not reach into a registry.

## Agnostic packages

An agnostic package is designed as if it were published to npm: anyone could copy its `src` into another project and use it. Lint owns the boundary; this section holds only what the AST cannot see.

- **Enforced by the `layer:island` tag** through `island.eslint.config.mjs`, a portable file that finds islands by tag in Nx's project graph: an island may depend only on other islands and may not import a host's runtime (the list `eslint.config.mjs` passes to `islandConstraint`), declares no `any` and no generic port signature, declares in its own `package.json` every package its shipped code imports, and, like all of `packages/**`, reads no `process.env` and writes no `console` (`packages/test` may print why a container test skipped). Carried by `packages/elt`, `packages/destinations/*`, `packages/google-auth`, `packages/macos/*`, `packages/queue/*`, `packages/test` and every source package in `packages/sources/<platform>/<name>`. A new agnostic package needs only the tag in its `project.json`. `packages/import-store` is not an island: it describes the user's Apple apps.
- **Also enforced:** no type assertions; no test lifecycle hooks; in every test, msw's `listen()` passes `onUnhandledRequest: 'error'`.
- **Ports are typed by the package.** A capability or decision the host owns enters as a parameter whose type the package exports, and the consumer conforms: `GoogleRequester` (`packages/google-auth/src/requester.ts`), `onRefreshed` on `GoogleOAuthApp.client`, and `directory` on `googleSession`, where each host decides where its grants live.
- **Stored shapes carry their own guards.** Anything the host persists and reads back is parsed by a static the package exports (`GoogleGrant.parse`).
- **Tests reach no network.** Stub below the dependency's transport with msw (`packages/google-auth/src/grant-opener.test.ts`). A test that needs Postgres gets its server from the caller and creates its own database on it (`scratchDatabase` in `packages/destinations/postgresql/src/index.test.ts`).

## Fake only what cannot run for real

Test against the real dependency: a real `Pipeline`, real SQLite or Postgres, a synthetic app database on disk. Fake a boundary only when the real one cannot produce the case, and say why beside the fake: `FakeEventKitHelper` stands in for the EventKit helper because EventKit cannot create attendees, a test cannot deny access or remove the ICS export, and a Mac's calendars can all sync to servers. A package that owns such a boundary exports its fake as a class under a `./test` subpath. Every other test helper lives in the test file that uses it; packages export no shared testing modules.

## Read every changed file before reporting done

Before calling a change finished, read each file it touched in full, not from memory, and remove what has no single concept or real consumer: forwarding wrappers, conversions of values whose types are known, defaults nobody overrides, exports nobody imports, and files left over from a split. Probe any claim that something cannot work before relying on it. Do this unprompted; the user should not have to audit file by file.
