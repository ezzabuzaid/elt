# The rules that the destinations share move into elt before the third destination

Status: accepted by Ezz (2026-11-19). This decision changes `@eltjs/elt`, elt-sqlite and elt-postgresql too.

elt-postgresql keeps copies of rules of elt-sqlite, recorded in `copied-from-elt-sqlite.md`, at strike 2 of the Rule of Three. Three backlog items wait for a third destination:

- #4289: the position rules: the sweep line that finds positions from the spans of loads, `parsePosition`, `expiry`, `positionsAfter` and `retain`.
- #4649: the refresh of a computed dataset (what is due: identity, input hash, the inputs that the passes tried, failed rows only on the refresh after the passes; and the pool of rule calls that commit as they settle), the waiting rule of `View`, and the writes of `derived_status`.
- #4669: `readPassStatus` and its `PassStatus` types.

The SQL Server destination numbers its commits, keeps derived datasets and keeps a sync history. It is the third place of each rule. The Rule of Three says: at strike 3, derive the boundary from the three copies, move the code, switch every copy to it and delete the copies.

Ezz put the SQL Server destination last on 2026-11-19: first the extraction, the open defects and the gaps, such as the parts of a table rule (ADR 0026 of elt), which are written one time in the shared refresh.

## Decision

- The rules move into `@eltjs/elt` now, beside `Rule` and the `Destination` port, as concepts that each destination drives with its own storage: a `Position` and its rules; a refresh of a computed dataset that asks the destination for the inputs, the output rows and one commit; the waiting rule of a view, with the missing-relation error that each store gives (SQLite `no such table`, Postgres `42P01`, SQL Server 208); and `PassStatus` with the rule that combines the passes.
- The boundary comes from the two working copies and this paper. Each API that moves is checked against the ADRs of this paper, so that the SQL Server destination writes only its storage. ADR 0002 changes how a destination finds the high-water mark, not the rule that makes a commit a position.
- `copied-from-elt-sqlite.md` and the three backlog items close when the copies are gone.

## Considered Options

- **A third copy, with a ledger, and no extraction.** The Rule of Three forbids it at strike 3, and each fix would go into three places.
- **A shared package of its own, such as `@eltjs/positions`.** The rules are concepts of elt (position, refresh, pass), and every destination already depends on `@eltjs/elt`.
- **Write the SQL Server copies first, and extract from three working copies.** The SQL Server destination would come before the gaps, and the parts of a table rule would go into three copies, or wait for the destination.
- **Extract now from the two copies, checked against this paper, and build the SQL Server destination last.** This option was selected.

## Consequences

- elt-sqlite and elt-postgresql change in the same series of commits, and their tests prove that they read the same positions, statuses and outputs as before.
- A boundary from two copies can miss a difference that only the third shows. When the SQL Server destination cannot use an API as it moved, the API changes in `@eltjs/elt`; the destination does not keep a copy.
- The SQL Server destination, and each destination after it, writes only its storage.

Sources: backlog #4289, #4649, #4669; elt-postgresql `docs/copied-from-elt-sqlite.md`.
