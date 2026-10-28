# @workspace/elt

Copies the data of apps and services into stores that SQL can read. A source reads an upstream, for example the Mail store of a Mac. A destination keeps each stream as a table, for example in one SQLite file. The pipeline starts the copies, and it keeps derived datasets in step with what they load. A derived dataset is data that the pipeline can always make again from the loaded data, for example the text of each stored file, or a view that counts rows. Kleppmann calls it derived data, and Estuary calls it a derivation.

This README tells about derived datasets. The other parts of elt are in the [API and behavior reference](../../docs/reference.md) until they move here.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Declare derived datasets on the pipeline

```ts
import { DocumentText, LocalFiles, Pipeline } from '@workspace/elt';
import {
  ComputedDataset,
  SQLiteSyncHistory,
  View,
} from '@workspace/elt-sqlite';
import { MacOSDocumentParser } from '@workspace/source-apple-macos/macos-document-parser';

const pipeline = new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [connection],
  derived: [
    // Computed on write: a rule makes one output for each stored file.
    new ComputedDataset({
      into: sqlite,
      name: 'document_text',
      description: 'The text of each stored document.',
      from: [documents],
      compute: new DocumentText({
        parser: () => new MacOSDocumentParser(),
        files: files.directory,
        column: 'documentRef',
      }),
    }),
    // Computed on read: SQLite runs the query at each read.
    new View({
      into: sqlite,
      name: 'document_count',
      description: 'How many documents loaded.',
      columns: { n: 'Number of documents.' },
      sql: 'SELECT count(*) AS n FROM documents',
    }),
  ],
});
```

`connection` copies a stream into the table `documents`, and `files` is the `LocalFiles` that keeps its stored files. Each kind of derived dataset is a class of a destination package. The SQLite destination has `View` and `ComputedDataset`; see [elt-sqlite](../destinations/sqlite/README.md). The Postgres destination has no kinds yet. See [ADR 0001](./docs/adr/0001-derived-data-is-declared-on-the-pipeline.md).

## When the pipeline refreshes

- **A run** refreshes each derived dataset after the passes of all connections, also when some copies failed. Then it rejects with `PipelineError`. See [ADR 0002](./docs/adr/0002-a-run-refreshes-its-derived-data-also-when-copies-failed.md).
- **A watch** refreshes after each pass, in the background. One refresh runs at a time. A pass that commits while a refresh runs asks for one more refresh after it. Thus no pass waits for a refresh. See [ADR 0003](./docs/adr/0003-a-watch-refreshes-in-the-background-one-refresh-at-a-time.md).
- The pipeline refreshes the derived datasets in the order of the list. A view that comes after a computed dataset can read the view of that dataset.
- A run does not refresh after an abort, or after an error that no sync history recorded. A stop that comes after the passes only stops the refresh. The next refresh continues the work.

## Write a rule

A computed dataset gives each input to its rule. A rule is a class that extends `Rule<Input, Output>`:

| Member                    | Gives                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `key`                     | the name and the description of the key column, for example `ref`                                    |
| `output`                  | the columns that the rule adds to each output, each `text` or `blob`, with a description             |
| `batch`                   | how many inputs one call of `compute` takes, for example the texts of one model call                 |
| `concurrency`             | how many calls of `compute` run at the same time, for example files that are parsed side by side     |
| `read(row)`               | the key and the input of one loaded row, or `null` when the row has no input                         |
| `identity(input)`         | the rule identity of the input, or `null` when the rule does not handle it                           |
| `compute(inputs, signal)` | one output for each input, in order: `{ value }`, `{ empty: true }`, `{ error }` or `{ gone: true }` |

The dataset makes an output again when its input or its rule identity changes. See [ADR 0005](./docs/adr/0005-an-output-is-made-again-when-its-rule-identity-changes.md).

Two rules exist:

| Rule                                      | Package                | Input                                                | Output                                                                                                       |
| ----------------------------------------- | ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `DocumentText({ parser, files, column })` | `@workspace/elt`       | the ref in `column`, relative to the folder `files`  | `content`, the text that a `DocumentParser` reads. The rule identity is the parser of the format of the file |
| `Embedding({ model, key, fields })`       | `@workspace/embedding` | the text of `fields`, with a line break between them | `vector`, from an AI SDK embedding model. The rule identity is the provider and the id of the model          |

`DocumentText` asks for its parser at each refresh, so a parser that the host changed, for example a new speech model, applies from the next refresh.

## When something fails

- **A rule failure** is the output of its input: the status `failed` and the reason. The load and the run continue, and the next refresh tries the input again. See [ADR 0004](./docs/adr/0004-a-rule-failure-stays-on-its-output.md).
- **A dataset failure**, for example SQL that SQLite refuses, rejects the run as itself, or it stops the watch.
- **A copy that failed** keeps its last committed rows. The derived data of those rows stays as it was.

## The same concepts in other systems

| Here                       | Elsewhere                                                                    |
| -------------------------- | ---------------------------------------------------------------------------- |
| Derived dataset            | Derived data (Kleppmann); a derivation (Estuary Flow); an asset (Dagster)    |
| View and computed dataset  | A dbt model that is materialized as a view, or as a table                    |
| Computed dataset with rule | A pgai vectorizer, which keeps an embedding of each row in step with the row |
| Rule identity              | The model of a pgai vectorizer: when it changes, pgai embeds the rows again  |
| Rule failure               | A row of `ai.vectorizer_errors` in pgai                                      |
| One refresh in the queue   | A build watcher, which keeps one rebuild in its queue while a rebuild runs   |

Airbyte has no step after a load. elt has one, because its hosts have no orchestrator.

## Decisions

- [ADR 0001](./docs/adr/0001-derived-data-is-declared-on-the-pipeline.md): derived data is declared on the pipeline.
- [ADR 0002](./docs/adr/0002-a-run-refreshes-its-derived-data-also-when-copies-failed.md): a run refreshes its derived data also when copies failed.
- [ADR 0003](./docs/adr/0003-a-watch-refreshes-in-the-background-one-refresh-at-a-time.md): a watch refreshes in the background, one refresh at a time.
- [ADR 0004](./docs/adr/0004-a-rule-failure-stays-on-its-output.md): a rule failure stays on its output.
- [ADR 0005](./docs/adr/0005-an-output-is-made-again-when-its-rule-identity-changes.md): an output is made again when its rule identity changes.

## Development

Run the commands from the workspace root.

```sh
npx nx run elt:test        # builds, then runs src/index.test.ts
npx nx run elt:typecheck   # formats, lints, then type checks
npx nx run elt:build       # compiles src/ to dist/
```

The files of derived data:

```
src/core/
  derived-dataset.ts    DerivedDataset: the port of each kind
  derived-refreshes.ts  the refreshes of a watch, one at a time
  pipeline.ts           Pipeline: run, watch, and the refresh after the passes
  rule.ts               Rule, RuleResult, LoadedRow, RuleColumn
  document-text.ts      DocumentText: the text of each stored file
```
