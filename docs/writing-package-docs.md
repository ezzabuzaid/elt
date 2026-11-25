# How to write the docs of a package

Each `@eltjs/*` package keeps its docs beside its code. This guide gives the kinds of doc, the shape of each kind, the style, and the commit. People and agents follow it. The `/coding:update-docs` skill follows it with no person present, so each rule is one that a reader can check in the file. Each shape names one file that already has it. This guide is a copy of the guide of zukhruf, with the changes that [copied-docs-guide.md](./copied-docs-guide.md) lists.

## The kinds of doc

The kinds follow [Diátaxis](https://diataxis.fr/), which sorts docs into tutorials, how-to guides, reference and explanation. The decision records follow Michael Nygard's [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) (2011), with the `decision-makers` field and the `Considered Options` and `Confirmation` sections of [MADR](https://adr.github.io/madr/). The glossary is the ubiquitous language of one bounded context, from Eric Evans, _Domain-Driven Design_ (2003).

| Kind                  | Path in the package                                   | What it is for                                                                                                                                     | Diátaxis                   |
| --------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| README                | `README.md`                                           | The entry page: what the package does, a task section for each use, the errors, and links to the other docs.                                       | how-to guide and reference |
| Glossary              | `CONTEXT.md`                                          | One meaning for each word of the package, and the words to avoid.                                                                                  | reference                  |
| Concept               | `docs/concepts/<topic>.md`                            | How one idea of the package works, and why.                                                                                                        | explanation                |
| Recipe                | `docs/recipes/<task>.md`                              | One use case, solved with a full program that runs.                                                                                                | how-to guide               |
| Reference page        | `docs/<group>/<name>.md`                              | One page for each member of a family, in one fixed shape.                                                                                          | reference                  |
| Decision record (ADR) | `docs/adr/NNNN-<title>.md`                            | One decision, who made it, its reason, its evidence, and the options that lost.                                                                    | explanation                |
| Index                 | `docs/README.md`                                      | A list of all docs of the package.                                                                                                                 | none                       |
| Copy ledger           | `docs/copied-code.md`, `docs/copied-from-<source>.md` | Each copy of code, as the Rule of Three asks. The root `docs/copied-<topic>.md` files list copies across packages. This guide does not cover them. | none                       |

No elt package has a concept or a reference page yet. The first one takes its shape from this guide.

The workspace also has one root file that every package uses: [CONTEXT-MAP.md](../CONTEXT-MAP.md) has one row for each context. A decision that applies to more than one package goes in `docs/adr` at the root, which elt does not have yet.

## README

Example: [packages/destinations/sqlserver/README.md](../packages/destinations/sqlserver/README.md).

````md
# @eltjs/<npm name>

<What the package does, in one or two paragraphs.>

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it <!-- the install command, then the smallest program -->

## <Task sentence> <!-- one section for each use, in the order a reader needs them -->

## Errors <!-- a table: | Error | When | -->

## What the package does not do

## Who uses it <!-- a table: | Consumer | How | Record | -->

## The same concepts in other systems <!-- a table: | Concept | Other systems | -->

## API <!-- one ```ts block of the public types -->

## Documentation <!-- links to the concepts, recipes, ADRs and copy ledger -->

## Development <!-- the nx commands and the src/ layout -->
````

- The title is the npm name: `# @eltjs/elt-sqlite` for the folder `packages/destinations/sqlite` ([README](../packages/destinations/sqlite/README.md)).
- A task section title is an imperative sentence: "Copy a stream", "Write a rule" ([elt](../packages/elt/README.md)), "Load a stream into SQL Server" ([elt-sqlserver](../packages/destinations/sqlserver/README.md)).
- A fixed section has a fixed title: `## Use it`, `## Errors`, `## What the package does not do`, `## Who uses it`, `## The same concepts in other systems`, `## API`, `## Documentation`, `## Development`. Write only the sections that have content. Keep the order above.
- `## Errors` lists each error class that a caller handles differently, in a table with the columns `Error` and `When` ([elt-sqlserver](../packages/destinations/sqlserver/README.md)). elt-sqlite and chunking use the title "When something fails" for the same section.
- `## What the package does not do` is a list. Each item starts with a bold sentence, then gives the reason or the ADR.
- `## Who uses it` is optional. It is a table with the columns `Consumer`, `How` and `Record`: each package or app that uses this one, the call it makes and the code it replaced, and the backlog item or ADR of that move. A package whose parts have different users writes `## Who uses each part`. Keep it out of `## Documentation`, which only links.
- `## The same concepts in other systems` names each system with its file, line or link ([chunking](../packages/chunking/README.md)).
- `## Documentation` links each concept, each recipe and each ADR. When it links more than one kind, group the links under the bold labels `**Concepts**`, `**Recipes**` and `**Decisions**`. A recipe link drops the word "Recipe:". An ADR link is `- [ADR NNNN](./docs/adr/NNNN-….md): <title, first word in lower case>.` elt-sqlite writes `## Recipes` and `## Decisions` as two sections ([README](../packages/destinations/sqlite/README.md)); this is allowed.
- `## Development` is optional. Write it when the package has more to say than the standard targets, such as the `src/` layout with one line for each file ([elt-sqlite](../packages/destinations/sqlite/README.md)).

## Glossary: CONTEXT.md

Examples: [packages/elt/CONTEXT.md](../packages/elt/CONTEXT.md) (with sources), [packages/destinations/sqlite/CONTEXT.md](../packages/destinations/sqlite/CONTEXT.md).

```md
# <Context name>

<One short paragraph: what the context is.>

## Language

### <Group> <!-- optional -->

**Term**:
<Definition: what the term is, in one to three sentences.>
_Avoid_: Word, other word (the reason, when one is useful)
```

- Each entry is `**Term**:` on its own line, then the definition, then `_Avoid_: …` as its last line. A definition can hold a list. One blank line separates two entries.
- When a definition takes a word from a standard, cite it in the definition: a book ("Kleppmann's derived data" in elt's "Derived dataset"), a man page and its lines, or the upstream doc.
- An `_Avoid_` item can carry its reason in parentheses: "Materialization (Estuary and Dagster use it for a write to a destination)".
- Other `##` sections are rare. Add one only for terms that need a common frame.

## Concept

```md
# <Concept name, or a sentence: "How a pipeline refreshes a derived dataset">

<Context: one paragraph, with the term in bold where it is defined.>

## <Topic> <!-- as many as the concept needs -->

## Evidence <!-- the last section: one bullet for each test or source, with what it proves -->
```

- An Evidence bullet names the file and the fact: "`src/<file>.test.ts`: <the fact that the test proves>."

## Recipe

Examples: [packages/destinations/sqlite/docs/recipes/search-the-text-of-stored-files.md](../packages/destinations/sqlite/docs/recipes/search-the-text-of-stored-files.md) (output to compare), [packages/chunking/docs/recipes/cut-documents-into-chunks-and-embed-each-chunk.md](../packages/chunking/docs/recipes/cut-documents-into-chunks-and-embed-each-chunk.md) (a model makes the output).

````md
# Recipe: <Imperative sentence>

**Use case.** <The situation, the problem, and what goes wrong without the package.>

**What you need.** <The inputs: the classes, a model, a server.>

## The steps

1. <One instruction.>
2. <One instruction.>

## The program

<One or two sentences: what the program does.>

```ts title="<file>.ts"
<the full program>
```

Output:

```
<the real output of one run>
```

## What the output shows <!-- or: ## Why it works -->

## Things to know

- **<A bold sentence.>** <The detail, with a link to the ADR or README section.>
````

The rules:

1. The program runs as written. It has all its imports and no `...`. It needs no file that the recipe does not give.
2. The output is the real output of a run of that program. Run it, and paste what it printed. Never write output by hand. Precedent: commit `c3389bb0` (#3869), where six recipes ran again after their pipelines needed a clock, and each output block is the output of that run.
3. When the output changes from run to run or from machine to machine, say how it was made in the line before the block: "Output on a Mac with 14 CPUs, while other programs also ran:", "Output (the time changes from run to run):". Name the model and the server version when a model makes the output ("EmbeddingGemma 2 Q8_0 on llama.cpp b11960").
4. When you change the program, run it again, and paste the new output.
5. Write `## What the output shows` when the lesson is in the numbers. Write `## Why it works` when the lesson is the mechanism.
6. A program that needs a server first gives its start command in a ```sh block before the program.
7. Each `@eltjs/*` package exports only its built `dist`. Build the packages that the program imports with `npx nx build <project>`. Then run the program as `node <file>.ts` from a temporary file inside the package folder, so each `@eltjs/*` import resolves through the workspace's `node_modules` (#3869). Delete the temporary file after the run.

The allowed variants:

- `## The problem` with a broken program and its output, then `## The solution` with the fixed one.
- `## The rules`, `## Example 1: …`, `## Example 2: …` and a test section, for a recipe that implements an interface, such as a rule or a kind of derived dataset.
- Extra topic sections before `## Things to know`, and `## Next steps` at the end.

## Decision record (ADR)

Examples: [packages/elt/docs/adr/0020](../packages/elt/docs/adr/0020-a-source-gives-its-change-signals-and-a-failed-signal-fails-only-its-streams.md) (`## Decision`), [packages/elt/docs/adr/0004](../packages/elt/docs/adr/0004-a-rule-failure-stays-on-its-output.md) ("Thus"), [packages/destinations/postgresql/docs/adr/0010](../packages/destinations/postgresql/docs/adr/0010-readers-look-in-marts-and-elt-keeps-its-tables-in-warehouse.md) (superseded in part).

```md
# <The decision, as a sentence>

<Status line: line 3.>

Decision-makers: <who decided, and on what>.

<Context: the problem and the facts, as prose or a list. No heading.>

## Decision

<The decision, first sentence; then its details.>

## Considered Options

- **<Option.>** <Why it lost.>

## Consequences

<What changes, what it costs, what stays open.>

## Confirmation

<The evidence: the red and green tests, the mutation results, the measurements, and the sources of the top performers with file:line.>
```

- The file is `docs/adr/NNNN-<title in lower case, words joined by hyphens>.md`. The numbers count from `0001` in each package. A new ADR takes the highest number plus one. A number is never used again.
- Write the decision under `## Decision`. Older ADRs give it in a paragraph that begins "Thus …", after the context. Do not rewrite them.
- A status paragraph starts on line 3. When there are more, the newest comes first. The forms are:
  - `Superseded on <date> (#NNNN) by [ADR NNNN](./NNNN-….md): <what is now true>.` Add "for <part>" when the rest stays true.
  - `Superseded in part on <date> (#NNNN) for <part>. <What is now true> ([ADR NNNN](./NNNN-….md)).`
  - `Status: Accepted <date> (backlog #NNNN).`
  - `Status: Proposed <date> (backlog #NNNN).`
- To change a decision, write a new ADR. Add a status paragraph to the old one, and keep its text. Mark it in the README list: "(superseded by ADR 0014)".
- **The status says whether the decision-makers agreed.** Nygard: "A decision may be 'proposed' if the project stakeholders haven't agreed with it yet, or 'accepted' once it is agreed." The status line has only the status, the date and the backlog items. The evidence is the reason for the decision, so it goes in the body, not in the status line.
- **The `Decision-makers:` line, on line 5, names each one who decided, as the `decision-makers` field of [MADR](https://github.com/adr/madr/blob/main/template/adr-template.md) does.** A session or an agent that decided from the evidence is named by its session name ("the elt session elt-9d"). The owner is a decision-maker only where the owner chose on a split that the evidence did not decide. Name each such split, and quote the owner's words for it.
- **The owner is never asked to approve a design.** The evidence and the top performers decide it. Ask the owner only on a split that the evidence does not decide.
- **`## Confirmation` gives the evidence, as the `Confirmation` section of MADR does: how the decision and its implementation are confirmed.** Give the red and green tests and their commit, the mutation results, the measurements with the versions, and the sources of the top performers with their file and lines.
- Older ADRs have no `Decision-makers:` line or `## Confirmation`, and some carry the evidence or the decision-maker in their status paragraph ("Status: accepted by Ezz (2026-11-19). Backlog #4886."). Do not rewrite them. Bring an old ADR to this shape only when you edit it for another reason.
- A decision for more than one package goes in the root `docs/adr`, numbered there.

## Index and map

- `docs/README.md` has the title `# Documentation`, the line `Start with the [project README](../README.md). The glossary is in [CONTEXT.md](../CONTEXT.md).`, then `## Concepts`, one section for each reference group, `## Recipes` (numbered), `## Architecture decision records` (numbered, by title) and `## Copied code`. When a package has one, keep it in step with the README. Do not add one to a package that has none.
- The README lists each recipe and each ADR of the package (see README above).
- [CONTEXT-MAP.md](../CONTEXT-MAP.md) has the columns `Context`, `Glossary` and `Decisions`. Each package with a `CONTEXT.md` has one row. The `Glossary` cell links the `CONTEXT.md`. The `Decisions` cell links the `docs/adr` folder, or says `none`.

## Style

The style is the one of the `wait-what` skill: "give me a little bit of context, talk in ASD-STE100 Simplified Technical English, and use the ubiquitous language".

- Give a little context first: one or two sentences that say what the page is about, before any detail.
- Write [ASD-STE100](https://www.asd-ste100.org/) Simplified Technical English. Use short sentences and the active voice. Write one instruction in each sentence. Give each word one meaning.
- Use the words of the package's `CONTEXT.md`. Do not use its `_Avoid_` words.
- Write the titles of task sections, recipes and ADRs as sentences. A concept, a reference page or a fixed section can have a name as its title ("Columns", "Errors").
- Cite the evidence for each claim: an issue (`#3869`), a commit, a man page and its lines, an upstream doc with a link, or a test file. An issue is an agent-backlog item: `agent-backlog show 3869` prints it.
- Use the term of the industry, with its source. When no term fits and you make one, say so in the same sentence.

## Commit

```
docs(<nx project name>): <the fact that the doc now says, a sentence in lower case> (#NNNN)
```

- The scope is the Nx project name, as `npx nx show projects` lists it: `elt-sqlite`, not `destinations/sqlite`.
- A commit that changes only root files has no scope: `docs: …`.
- Do not write a second "): " after the scope. nx release reads the scope up to the last "): ", and the commit-msg step `NxReleaseScope` of `@zukhruf/git-hooks` ([.husky/commit-msg.ts](../.husky/commit-msg.ts)) refuses such a subject. Write "(#3840); " in its place.
- A `docs` commit changes no version: the nx default is `docs: { semverBump: 'none' }`.

Real subjects:

```
c3389bb0 docs(elt-sqlite,source-arc-desktop,source-chromium-browser,source-dia-desktop,source-web-pages): six recipes give their pipeline clock: globalThis, as the README of elt does, so their programs run again after 16339ab2 made the clock required (#3869)
61508f33 docs(sdk-web-product): the API on paper of a web SDK that reads the product a shop's page declares in its schema.org data, for review before any code (#5577)
```

## Before you hand off

1. Each relative link resolves to a file.
2. Each recipe program ran, and its output block is the output of that run.
3. Each new recipe, concept and ADR has a link in the README, and in `docs/README.md` when the package has one.
4. `npx prettier --check <each changed file>` passes. Run Prettier by path, never on the whole tree.
