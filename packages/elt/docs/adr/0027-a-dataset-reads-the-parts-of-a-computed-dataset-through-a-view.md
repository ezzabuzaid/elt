# A dataset reads the parts of a computed dataset through a view

Status: accepted by Ezz (2026-11-19). Design on paper for `@eltjs/chunking` (backlog #4737).

The `from` of a computed dataset names the targets of copies and the `View`s before it in `derived`, never another computed dataset (`from: readonly (SQLiteTable | View)[]` in elt-sqlite, and `(PostgresTable | View)[]` in elt-postgresql). A view can read the view of a computed dataset that comes before it. The chunks of a text are the parts of a computed dataset (ADR 0026), and the `Embedding` rule must read them.

Two forms can feed a computed dataset from another:

- **A chain.** `from: [chunks]`. The dataset that reads must then know which view to read (`<name>` or `<name>_parts`) and which rows: a `failed` output row has no text, and only `computed` rows are inputs.
- **A view between them.** dbt builds a model on a model through `ref()`, and the SQL of the model says which columns and rows it takes. A pgai vectorizer reads its source table or a view of it.

A view also does work that a chain cannot: it renames `part_hash` to the `key` that `Embedding` reads, it puts the title of a document before each chunk with a join, and it leaves out chunks that are too short to mean something. Each destination already has `View`, and a view waits for the computed dataset before it (ADR 0001 of elt-sqlite, ADR 0008 of elt-postgresql).

Thus a dataset reads the parts of a computed dataset through a `View`, for example `SELECT part_hash AS id, text FROM document_chunks_parts`. The engine adds no form of `from`.

## Considered Options

- **`from` names a computed dataset.** Each dataset that reads one must guess the relation and the rows, and the host cannot filter, rename or join.
- **`Embedding` takes the chunks as an option.** This joins the two rules again (ADR 0001 of `@eltjs/chunking`).
- **A view between the two datasets.** This option was selected.

## Consequences

- A chain from stored files to vectors has two views: one that gives the text that the parser read, and one that gives the chunk texts (README of `@eltjs/chunking`).
- `Embedding` needs no change.
- When a third host writes a view that only passes the rows through, `from` can name a computed dataset (Rule of Three).

Sources: #4737, #4740.
