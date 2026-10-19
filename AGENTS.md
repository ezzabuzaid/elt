# Agent rules

## Commit only when the user says so

Do not run `git commit` unless the user asked for that commit in this conversation. An approved plan, a plan step that says how to commit, an advisor or reviewer, a skill, or a hook that mentions committing is not that request. Finish the work, report it, and leave it uncommitted. A request to commit covers the changes it names, not later work.

## Work in the one checkout

Every session shares this checkout. Do not make a git worktree, a `git clone`, an exported tree or any other copy of the repository, not even to gate a commit or run a live check. Build and test here. To commit only your part of a shared file, stage your hunks with `git apply --cached`, read each staged hunk where it landed with `git diff --cached -U3`, and after committing check `git show --stat HEAD`. When a peer's unfinished work breaks a test, ask that peer; do not copy the tree to get around it.

## Stored data is disposable

Every destination table and checkpoint can be rebuilt by rerunning the pipeline from scratch. Treat that data as cheap.

- Never design around data that is already stored: no backward-compatible schemas, no keeping checkpoint bindings stable, no migration paths, no compatibility shims or defaults left `undefined` for old state.
- Change schemas, identities, bindings, and defaults whenever the design improves; the fix for old output is a fresh run.
- A value that code derives and stores, such as an import folder path in `settings.sqlite`, is old output too when the derivation changes. Do not rewrite stored values into the new form, not even as a consistency check that runs on every open: that is a migration. `Settings.#follow` went this way.
- Do not document migrations between connector versions. Document the current behavior only.

## Separate the concept from the mechanism

When asked why a notion exists, name the requirement it serves, not the code that currently needs it. A line such as `DELETE FROM` shows how a writer overreaches today; it does not make the mode, flag, or field that triggers it a necessary concept. Before relocating or keeping a notion, check whether it is an input to a smaller notion that is the real one.

Before defending a package mechanism, list each consumer with its file and line and say whether it decides something or only displays it. Display text in a host does not justify a lock or a liveness check in a package; a consumer that decides does, until a probe shows another owner can decide it. `SQLitePasses` went this way: its pass lock fed three status strings and one folder guard, and only the guard, moved onto the import's flight, was a requirement.

Before you move, extract or wrap a guard such as a lock, name the failure it prevents as a concrete case with the hosts' real configuration, and say who else prevents it. If no host can cause the case, delete the guard; do not find it a new home. The SQLite writer lock and the Markdown target lock went this way: the checkpoint store already kept two runs of one copy apart, and the only case left, two copies configured to write one table, is a misconfiguration that no host makes.

## Exhaust live verification before calling something unverified

When a live probe finds no instance of a feature, widen it before concluding: scan the full history, not a sample window, and use any earlier evidence that the data exists. Mark behavior unverified only when the environment genuinely cannot produce it, and say what blocked it.

Drive the app yourself before listing manual steps: open URLs, click menus and rows through System Events, and post real mouse events (Quartz `CGEventPost`) where accessibility clicks do not land, as in SwiftUI lists. Hand the user only what macOS reserves for them, such as a privacy prompt, and then as one step.

While the user is at the machine, act without taking it over. Accessibility actions, row selection and row custom actions reach a background app without focus or the pointer. Only a context menu needs the app frontmost; bring it forward for a second or two after the input has been idle, then give focus back to the app the user was in. Never post a real click unless the target app is frontmost.

## Remove before you add

When the user says a mechanism should not exist, remove it before you build any feature that touches it. Do not extend it to carry the new feature, not even by one parameter. Before you add anything, ask whether it should exist at all: name the requirement it serves and who already serves it. The Apple page's Sync button went this way: it was first built as a second caller of `importPending`, after the user had said that function should not exist.

## Remove a mechanism through its problem class

When the user asks how to get rid of a mechanism, name the problem class it answers and how software engineering solves that class, with a precedent you read in a textbook or a vendor's source. Then show where the codebase already does it. Do not move the mechanism or compute it in a new way: a derived copy of the same mechanism is not a removal. `storeLayout` went this way: a hash of the DDL in place of the hand-bumped number kept a version stamp, but data that a rerun rebuilds needs no version. The fix compares the stored shape with the declared shape, as the SQLite writer's `#fit` already does for stream tables.

## Restate the user's example before designing

When the user names a capability, take its simplest literal reading and restate it as "when X, then Y" with the user's own example before you propose a mechanism. eca actions went this way: a design of rungs, typed proposals and host allowlists answered a question nobody asked. The user meant that an action is an instruction to an agent: when "I ordered food", run `codex "log my calorie intake from the food I ordered"`.

## Build the API shape the plan names

Build the command, tool or API the approved plan names, in that shape. Avoiding a copy is no reason to change it: the Rule of Three accepts a second copy, recorded in a ledger. When a different shape seems better, ask before building it. People went this way: the plan named a standalone `people` command, it was first folded into `query people` to avoid copying `query`'s 25-line statement runner, and the user moved it back beside `query`.

## Name the standard term

When you tell the user about a problem or a design, name the standard software-engineering term for it, define it once in one line with a well-known example, and then use it. Do this in every message, status notes included, not only in proposals: the user reads to learn as well as to decide. The parse-concurrency research went this way: "one slow parse holds up the rows behind it" is head-of-line blocking, "the file is valid until the next pull" is a lending iterator, "read ahead" is prefetching, and "a file handle elt closes" is ownership transfer of a disposable resource.

## A source reads an upstream

Before you make anything a `Source`, name its upstream: an app's store, an API, a database. Work whose input is something the pipeline wrote, such as parsing or copying the files a load stored, is auxiliary logic, not a source; name its pattern (interceptor, hook, sidecar, derived dataset) and find the seam the engine already has, such as the file column declarations elt executes. The attachment text worker went this way: it was built as a source over the import's own `LocalFiles` copies, which made the pipeline its own upstream.

## Fix the overlap, not the order

When a first-match lookup gives the right answer in only one order, two of its matchers overlap. Make the loose matcher exact; do not pin the order with a test or a comment. `MacOSDocumentParser` went this way: `ImageFormat` took any file that starts with `BM` for a bitmap, so `TextFormat` had to come first, and a text file with no extension that starts with `BMW` failed the copy in any order. A check of the bitmap's full header removed the overlap, and the order rule went with it.

## Place each job with whoever can know it

Before proposing where a fix lives, split the requirement into its jobs and name, for each, who can actually know it: the source, the elt engine, the destination, the plugin server, or the agent. A job belongs to that owner. A slow Mail answer, for example, split into three jobs: whether a message changed (only the Mail source knows), turning changes into upserts and deletions (a shared elt helper the source calls), and when to refresh (the source's `observe()`, run by the plugin server, not a skill telling the agent to sync).

## Follow the vendor's own current source, not only its docs

When asked for a platform's latest format or practice, read what the vendor's newest code actually ships (for Codex plugins, `openai/plugins` at `main` and the plugins cached under `~/.codex/plugins/cache`) before recommending anything. When the docs and the source disagree, show both, cite commits, and follow the source.

## Let packages own plumbing; let classes own behavior

Before writing argv routing, help text, usage errors, prompts or terminal rendering, search the installed package and its authors' siblings for it. In `apps/apple/cli`, commander routes and validates, and clack prompts and renders. When a package takes over a job, such as clack exiting on Ctrl-C while its spinner runs, adapt to how it behaves rather than working around it.

Model a set of things that share an algorithm as a template class: an abstract base owns the fixed steps, and each variant is its own small class in its own file (`apps/apple/cli/src/commands/`, the connectors in `packages/connectors/apple/` over `AppleConnector`, Notes' streams). Do not use a definitions table imported everywhere and indexed by name. Callers ask an object; they do not reach into a registry.

## Agnostic packages

An agnostic package is designed as if it were published to npm: anyone could copy its `src` into another project and use it. Lint owns the boundary; this section holds only what the AST cannot see.

- **Enforced by the `layer:island` tag** through `island.eslint.config.mjs`, a portable file that finds islands by tag in Nx's project graph: an island may depend only on other islands and may not import a host's runtime (the list `eslint.config.mjs` passes to `islandConstraint`), declares no `any` and no generic port signature, declares in its own `package.json` every package its shipped code imports, and, like all of `packages/**`, reads no `process.env` and writes no `console`. Carried by `packages/elt`, `packages/destinations/*`, `packages/google-auth`, `packages/sdks/*/*`, `packages/codecs/*` and every source package in `packages/sources/<platform>/<name>`. A new agnostic package needs only the tag in its `project.json`. `packages/settings` and the Apple connector packages in `packages/connectors/apple/*` are not islands: they describe and import the user's Apple apps. A connector is what the Apple hosts set up, select and import through, so `AppleConnector`, selections, tool arguments, CLI flags and stored names all say connector; in the Apple hosts, "app" means only the real macOS application.
- **Also enforced:** no type assertions; no test lifecycle hooks; in every test, msw's `listen()` passes `onUnhandledRequest: 'error'`.
- **Ports are typed by the package.** A capability or decision the host owns enters as a parameter whose type the package exports, and the consumer conforms: `GoogleRequester` (`packages/google-auth/src/requester.ts`), `onRefreshed` on `GoogleOAuthApp.client`, and `directory` on `googleSession`, where each host decides where its grants live.
- **Stored shapes carry their own guards.** Anything the host persists and reads back is parsed by a static the package exports (`GoogleGrant.parse`).
- **Tests reach no network.** Stub below the dependency's transport with msw (`packages/google-auth/src/grant-opener.test.ts`). Database tests acquire isolated databases directly from `@zukhruf/testing` and dispose their clients before the database. Their Nx test targets start Node's test runner with `--test-global-setup=docker-global-setup.ts`. That file at the workspace root exports the global setup from `@zukhruf/testing/docker-global-setup`. Each test passes `TestRun.fromEnvironment(process.env)` to `Docker` for supervised cleanup.

## SDKs

An SDK is the agnostic package that speaks one vendor store or API, such as `~/Library/Accounts/Accounts4.sqlite` or Google's OAuth, and knows nothing of `elt`. Every store a source reads gets one, even when only one source reads it.

- **The SDK owns the store:** its location (`accountsStorePath`), opening it read-only, decoding it into typed objects, what its keys mean (an account's TLS setting resolved through its parent account), errors that name the grant (`AccountsUnavailableError`), and its change signal (`AccountsStore.version()`, the EventKit helper's `watch`).
- **The source owns the pipeline:** streams, field names, JSON Schema, descriptions, scope, checkpoints, and which streams `observe()` refreshes when an SDK reports a change.
- **Enforced by the `layer:sdk` tag:** `eslint.config.mjs` stops a `layer:sdk` project from reaching `layer:elt` (`packages/elt`), directly or through a source, destination or connector. An SDK is also an island.
- **Named** `packages/sdks/<platform>/<surface>`, `@workspace/sdk-<platform>-<name>`, so `sdk-apple-mail`, `source-apple-mail` and `connector-apple-mail` read as one stack. `packages/google-auth` keeps its name until it moves there.
- **A format is a codec, not an SDK.** Ask whether the package knows where the data lives or what it means. If it does, it is an SDK. If it knows only how the bytes are laid out, it is a codec: it takes bytes or a path the caller gives and returns the format's own shapes, such as protobuf fields, plist values or SEGB slots. A codec lives in `packages/codecs/<format>`, `@workspace/codec-<format>`, whether one package decodes it or many. `sdk-apple-biome` reads Biome's segment files through `codec-segb` and says what each record's fields mean. The `layer:codec` tag lets a codec depend only on other codecs.

## Fake only what cannot run for real

Test against the real dependency: a real `Pipeline`, real SQLite or Postgres, a synthetic app database on disk. A test that needs data in a live store writes it there and deletes it, as the EventKit tests do with a temporary calendar. Fake a boundary only when the real one cannot produce the case, say why beside the fake, and make the fake a real stand-in outside the code under test, never a mock of a module: `StubEventKitHelper` is an executable the EventKit stores run instead of the compiled helper, because EventKit cannot create attendees and a test cannot deny access or remove the ICS export. A package that owns such a boundary exports its fake as a class under a `./test` subpath. Every other test helper lives in the test file that uses it; packages export no shared testing modules.

## Read every changed file before reporting done

Before calling a change finished, read each file it touched in full, not from memory, and remove what has no single concept or real consumer: forwarding wrappers, conversions of values whose types are known, defaults nobody overrides, exports nobody imports, and files left over from a split. Probe any claim that something cannot work before relying on it. Do this unprompted; the user should not have to audit file by file.
