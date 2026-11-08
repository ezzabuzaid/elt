# Apple test fixtures copied into Context Compiler

A test of an Apple source writes a small copy of the app's store on disk. The Context Compiler tests in `~/Desktop/experiments/context-compiler` need the same stores, so they keep their own copies of these fixtures. The two repos are different repos and a package exports no test support, so the fixtures stay copied.

Mirror every fix in each copy and name each file in the commit. The ledger in the other repo is `docs/copied-apple-test-fixtures.md`, and it lists the same copies.

Paths on the left are in this repo. Paths on the right are in Context Compiler. The elt tests are the source: elt owns the code that reads these stores.

## NoteStore

`packages/sources/apple/notes/src/notes.test.ts` → `apps/cli/src/cli.e2e.test.ts` and `apps/server/src/plugin.e2e.test.ts`.

Copied without changes: `noteStoreSchema`, `noteEntities`, `noteTable`, `protobuf`, `NoteRun`, `noteBody` and `richNote`.

Copied with changes: `noteStoreFixture`.

- Both copies call `openDatabase` in place of `open`. Why: in `plugin.e2e.test.ts`, `open` is the function of `node:fs/promises`.
- `cli.e2e.test.ts` calls `appleSeconds` in place of `coreDataSeconds`. Why: its Safari fixture already defines that function.

`packages/sources/apple/notes/src/notes-source.test.ts` is a second place in the Notes package. It has the same fixture with more rows, because its tests read them:

- `noteStoreFixture` adds an account on this Mac, a folder in that account, a gallery attachment with a scanned page, a blank mention, a second location and a title on one attachment.
- `richNote` adds a run that holds the blank mention.

A third place in the Notes package moves the fixture to `src/testing/` (backlog #4048). `packages/sdks/apple/notes/src/note-store.test.ts` is not a copy: it names the file only.

## Safari

`packages/sources/apple/safari/src/safari.test.ts` → `apps/cli/src/cli.e2e.test.ts`.

Copied without changes: `writePlist`, `binaryPlist`, `escapeXml`, `xml`, `appleSeconds`, `int32s`, `bookmarksPlist`, `closedTabsPlist`, `historySchema`, `tabsSchema`, `cloudTabsSchema` and `archived`.

Copied with changes:

- `safariFixture` and `tabsFixture` call `openDatabase` in place of `open`.
- `safariFixture` in elt also writes `HistoryAgeInDaysLimit` to Safari's preferences, so its fixed visit dates do not expire. The copy does not write it.

`packages/sources/apple/books/src/books.test.ts` also has `escapeXml` and `xml`, without changes, and `writePlist`, which calls `run` in place of `execute`. The Books and Safari packages each have one place.

## Knowledge and Biome

`packages/sources/apple/activity/src/activity.test.ts` → `packages/connectors/activity/src/activity-presets.test.ts`.

Copied without changes: `knowledgeSchema` and `devicesSchema`.

Copied with changes: `protobuf` and `Field`. The copy has no `bytes` and no `message` field. Why: its records hold numbers and strings only.

## Messages

`packages/sources/apple/messages/src/messages-source.test.ts` → `apps/ipay/src/ipay.test.ts`.

Copied without changes: `chatSchema`.

Copied with changes: `appleNanoseconds`. The elt test takes the epoch from `@workspace/codec-apple-reference-date`. The copy writes `Date.UTC(2001, 0, 1)`.

## Mail

`packages/sources/apple/mail/src/mail.test.ts` → `apps/ipay/src/ipay.test.ts` and `packages/connectors/mail/src/mail-presets.test.ts`.

Copied with changes: `schema`, with the same text, is `envelopeIndexSchema` in both copies. The name says which store it describes, because `ipay.test.ts` also has `chatSchema`.

Not a copy: `mime`. In elt it is one fixed message. In `ipay.test.ts` it is a function that builds each email of the test.
