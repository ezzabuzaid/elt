# The third destination moves the rules that the three destinations share into elt

Status: proposed, for Ezz's review (2026-11-19). This decision changes `@eltjs/elt`, elt-sqlite and elt-postgresql too.

elt-postgresql keeps copies of rules of elt-sqlite, recorded in `copied-from-elt-sqlite.md`, at strike 2 of the Rule of Three. Three backlog items wait for a third destination:

- #4289: the position rules: the sweep line that finds positions from the spans of loads, `parsePosition`, `expiry`, `positionsAfter` and `retain`.
- #4649: the refresh of a computed dataset (what is due: identity, input hash, the inputs that the passes tried, failed rows only on the refresh after the passes; and the pool of rule calls that commit as they settle), the waiting rule of `View`, and the writes of `derived_status`.
- #4669: `readPassStatus` and its `PassStatus` types.

The SQL Server destination numbers its commits, keeps derived datasets and keeps a sync history. It is the third place of each rule. The Rule of Three says: at strike 3, derive the boundary from the three copies, move the code, switch every copy to it and delete the copies.

## Decision

- The rules move into `@eltjs/elt`, beside `Rule` and the `Destination` port, as concepts that each destination drives with its own storage: a `Position` and its rules; a refresh of a computed dataset that asks the destination for the inputs, the output rows and one commit; the waiting rule of a view, with the missing-relation error that each store gives (SQLite `no such table`, Postgres `42P01`, SQL Server 208); and `PassStatus` with the rule that combines the passes.
- The boundary comes from three working copies. The order (open question): (a) write the SQL Server copies first, beside the two others, and extract before the package leaves `"private": true`; or (b) extract first, from the two copies and the differences on this paper (ADR 0002 changes how a destination finds the high-water mark, but not the rule that makes a commit a position).
- `copied-from-elt-sqlite.md` and the three backlog items close when the copies are gone.

## Considered Options

- **A third copy, with a ledger, and no extraction.** The Rule of Three forbids it at strike 3, and each fix would go into three places.
- **A shared package of its own, such as `@eltjs/positions`.** The rules are concepts of elt (position, refresh, pass), and every destination already depends on `@eltjs/elt`.
- **Move the rules into elt at the third destination.** This option was selected.

## Consequences

- elt-sqlite and elt-postgresql change in the same series of commits, and their tests prove that they read the same positions, statuses and outputs as before.
- A fourth destination writes only its storage.

Sources: backlog #4289, #4649, #4669; elt-postgresql `docs/copied-from-elt-sqlite.md`.
