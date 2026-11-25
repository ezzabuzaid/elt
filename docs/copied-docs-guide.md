# The docs guide copied from zukhruf

The `/coding:update-docs` skill reads the guide that `.claude/update-docs.json` names. Its writers follow the guide, and its judge checks each draft against it. zukhruf (`~/Desktop/experiments/mutex`) has the guide that the elt docs follow, as AGENTS.md says. elt keeps its own copy so that the repository is complete without a zukhruf checkout beside it (Ezz, 2026-11-25).

Mirror every fix in both copies and name both files in the commit. elt is the second place, so the guide stays copied until a third repository needs it (Rule of Three).

`docs/writing-package-docs.md` in zukhruf, as of `ce024079` → `docs/writing-package-docs.md` in elt.

Copied without changes: the kinds of doc and their paths, each shape (README, glossary, concept, recipe, ADR), the recipe rules 1 to 6, the ADR rules, the index and map rules, the style, the commit rules and "Before you hand off".

Copied with changes:

- The scope is `@eltjs/*` in place of `@zukhruf/*`, and the examples are elt files. Why: a relative link to a zukhruf file does not resolve in elt.
- No example names a concept, a reference page or a `docs/README.md` index. Why: no elt package has one yet.
- The copy ledger row says the ledgers are written by hand. Why: elt has no `tools/copy-check`. The config refuses `**/docs/copied-*.md` for the same reason.
- The README rules drop the `readme-table:generate` rule. Why: elt has no `tools/readme-table`, and its root README lists the sources, not the packages.
- The README rules allow "When something fails" in place of "Errors". Why: elt-sqlite and chunking use that title, as launchd and docker do in zukhruf.
- Recipe rule 7 builds each package and runs the program from a temporary file inside the package folder, without `--conditions=@zukhruf/source`. Why: each `@eltjs/*` package exports only its built `dist` (#3869).
- The ADR rules show the status form of the older elt ADRs ("Status: accepted by Ezz (2026-11-19). Backlog #4886."), which a writer does not rewrite.
- A root `docs/adr` is a folder that elt does not have yet.
- The commit rules link `NxReleaseScope` through `.husky/commit-msg.ts`, and the real subjects are elt commits.
