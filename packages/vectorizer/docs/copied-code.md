# Code copied in this package

The Postgres subpath writes a string literal of SQL in two places: the text between two `'`, with each `'` in the text written twice. This package keeps one copy in each place, and does not share it yet.

The reason is the Rule of Three. It counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. Until then, a fix in one copy is made in the other copy too, and the commit names both files.

The backlog item elt #5618 extracts it into elt-postgresql when a third place needs it.

Paths are in `packages/vectorizer/src`.

## Copied with changes

| Source                                | Copy                                                             | What differs                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `postgresql/vectorizer.ts`, `literal` | `postgresql/keyword-index.ts`, the constructor of `KeywordIndex` | The copy is inline: it writes the text search configuration into the `to_tsvector` call of the generated `keywords` column. |
