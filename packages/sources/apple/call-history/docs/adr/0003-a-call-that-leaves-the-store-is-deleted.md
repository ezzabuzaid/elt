# A call that leaves the store is deleted

A call can leave the store for three reasons: the user removed it from Recents, Core Data cascaded a deletion, or callhistoryd dropped it. The store keeps no record of the reason. On this Mac, all 521 phone calls before 2025-07-07 left the store at the same time. The logs of callhistoryd showed no removal in the next 30 days, and CallHistory has no retention rule.

elt can keep the rows of records that an upstream drops only by a horizon (`expiresBy`), and a horizon needs a retention rule. CallHistory has none. Thus every stream is a snapshot stream with deletions (the deletion policy `ClosedWorld`), and a call that leaves the store is deleted from the destination.

## Considered Options

- **Keep every row (no deletions).** A call that the user removed then stays in the destination.
- **Expire calls by a horizon.** No retention rule gives a horizon.
- **Delete each call that leaves the store.** This option was selected.

## Consequences

- The destination shows the store as it is now.
- If callhistoryd drops old calls again, the source deletes them from the destination too.

Sources: commit 0e07d451.
