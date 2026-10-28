# @workspace/elt-sqlite

The SQLite destination of elt. It keeps the stream of each copy as a raw table in one SQLite file, with a reader view over it and a catalog that describes each table, view and column. A reader queries the file with SQL, for example with `sqlite3 -readonly`. The SQLite destination also has two kinds of derived dataset: a `View`, which SQLite computes on each read, and a `ComputedDataset`, which a rule computes on write. A dbt model has the same two kinds: it is materialized as a view or as a table.

This README tells about the derived datasets. The other parts of the SQLite destination are in the [API and behavior reference](../../../docs/reference.md) until they move here.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md), and the glossary of [elt](../../elt/CONTEXT.md) for the words of all of elt.

## Declare a view

```ts
import { View } from '@workspace/elt-sqlite';

const unread = new View({
  into: sqlite,
  name: 'unread_count',
  description: 'How many messages each chat has that the user did not read.',
  columns: {
    chat: 'The chat.',
    n: 'Number of messages that the user did not read.',
  },
  sql: 'SELECT chat, count(*) AS n FROM messages WHERE read = 0 GROUP BY chat',
});
```

Give the view to the pipeline in `derived`. `sqlite` is the `SQLiteDestination` of the copies.

- A view names no inputs. Its SQL reads them. See [ADR 0001](./docs/adr/0001-a-view-names-no-inputs.md).
- The view appears when its query compiles. Thus a reader never finds a view that fails.
- While the SQL reads a raw table or a reader view that a copy of the pipeline has not made yet, the view waits. It appears at the refresh after that copy loads.
- Any other error of the query, for example a misspelled table, is a dataset failure. It fails the run with the error of SQLite.
- The columns must be the same as the columns that the query gives, and the catalog lists them with their descriptions.
- A view that comes after a computed dataset in `derived` can read the view of that dataset.
- A refresh that changes nothing does not change the schema of the SQLite file.

## Declare a computed dataset

```ts
import { DocumentText } from '@workspace/elt';
import { ComputedDataset } from '@workspace/elt-sqlite';

const text = new ComputedDataset({
  into: sqlite,
  name: 'document_text',
  description: 'The text of each stored document.',
  from: [documents],
  compute: new DocumentText({
    parser: () => parser,
    files: files.directory,
    column: 'documentRef',
  }),
});
```

`documents` is the target of a copy, and `from` can name more than one. The rule reads each row that those copies loaded. See [Write a rule](../../elt/README.md#write-a-rule) in elt.

A computed dataset keeps one output row for each key, in the table `raw_<name>`. Readers query the view `<name>`:

| Column       | Holds                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| the key      | the key of the input, with the name that the rule gives, for example `ref`                                     |
| `input_hash` | the SHA-256 of the input                                                                                       |
| `rule`       | the rule identity, for example the parser of the format. `unsupported` when the rule does not handle the input |
| `status`     | `computed`, `empty` or `failed`                                                                                |
| `error`      | why the rule failed, or `NULL`                                                                                 |
| rule columns | the columns of the rule, for example `content`                                                                 |

At each refresh, the computed dataset compares the inputs with the output rows. See [ADR 0002](./docs/adr/0002-a-computed-dataset-keeps-one-output-row-for-each-key.md):

- It computes each key that is new, whose input or rule identity changed, or whose status is `failed`.
- It deletes each output row whose key no input has any more.
- It keeps an output row when the rule stops handling its input.
- Each call of the rule commits as it settles, so readers see the output rows as they land. See [ADR 0003](./docs/adr/0003-each-rule-call-commits-as-it-settles.md).
- When the declaration of the raw table changes, the refresh makes the table again. See [ADR 0004](./docs/adr/0004-a-changed-declaration-makes-the-table-again.md).

## When something fails

- **A rule failure** gives an output row with the status `failed` and the reason in `error`. The run continues, and the next refresh tries the input again.
- **A dataset failure**, for example a query that SQLite refuses, rejects the run, or it stops the watch.
- **A copy that failed** keeps its last committed rows. The derived datasets read those rows.

## Recipes

One use case each, with a full program that you can run:

- [Search the text of stored files with SQL](./docs/recipes/search-the-text-of-stored-files.md)

## Decisions

- [ADR 0001](./docs/adr/0001-a-view-names-no-inputs.md): a view names no inputs.
- [ADR 0002](./docs/adr/0002-a-computed-dataset-keeps-one-output-row-for-each-key.md): a computed dataset keeps one output row for each key.
- [ADR 0003](./docs/adr/0003-each-rule-call-commits-as-it-settles.md): each rule call commits as it settles.
- [ADR 0004](./docs/adr/0004-a-changed-declaration-makes-the-table-again.md): a changed declaration makes the table again.

## Development

Run the commands from the workspace root.

```sh
npx nx run elt-sqlite:test        # builds, then runs src/*.test.ts
npx nx run elt-sqlite:typecheck   # formats, lints, then type checks
npx nx run elt-sqlite:build       # compiles src/ to dist/
```

The files of derived datasets:

```
src/
  view.ts                    View: a view that SQLite computes on each read
  computed-dataset.ts        ComputedDataset: one output row for each key
  sqlite-views.ts            publishSQLiteViews: makes described views and checks their columns
  view.test.ts               the tests of View
  computed-dataset.test.ts   the tests of ComputedDataset, and of the refreshes of a run and a watch
```
