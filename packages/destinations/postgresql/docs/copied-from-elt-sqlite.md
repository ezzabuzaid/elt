# Code copied from elt-sqlite

The SQLite destination and the Postgres destination both number their commits and give positions. The rule that makes a commit a position is the same in both. This package keeps its own copy of the code that applies the rule, and does not share it with elt-sqlite yet.

The reason is the Rule of Three. It counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. When a third destination numbers its commits, the shared parts move to one home, probably `@eltjs/elt` (backlog #4289). Until then, a fix in one copy is made in the other copy too, and the commit names both files.

Paths on the left are in `packages/destinations/sqlite/src`. Paths on the right are in `packages/destinations/postgresql/src`.

## Copied with changes

| elt-sqlite                                           | elt-postgresql                            | What differs                                                                                                                                               |
| ---------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sqlite-loads.ts`, the sweep line in `readNumbering` | `postgres-numbering.ts`, `ends`           | Postgres reports only the ends at or below the high-water mark. SQLite writes one transaction at a time, so each commit it sees is settled.                |
| `sqlite-loads.ts`, `expiry`                          | `postgres-numbering.ts`, `expiry`         | "file" reads "database". Postgres compares with the high-water mark, not the newest number. Postgres has no retention yet, so it has no `min_valid` check. |
| `sqlite-loads.ts`, `parsePosition`                   | `postgres-numbering.ts`, `parsePosition`  | The error names a Postgres database.                                                                                                                       |
| `sqlite-loads.ts`, `positionsAfter`                  | `postgres-numbering.ts`, `positionsAfter` | Async. It does not filter by `min_valid`.                                                                                                                  |

## Knowledge in both, written apart

- A load of a connector that is still open when a new load of the connector opens is closed by the new load. A closed load cannot commit. SQLite checks `closed_at` in the `INSERT` of the commit, because it runs one write transaction at a time. Postgres locks the row of the load `FOR SHARE`.
- A clear is a load of one commit, which does not close the open loads of its connector.
