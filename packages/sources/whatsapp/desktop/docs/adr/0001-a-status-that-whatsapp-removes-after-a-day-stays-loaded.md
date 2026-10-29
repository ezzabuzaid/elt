# A status that WhatsApp removes after a day stays loaded

WhatsApp keeps a contact's status for one day after it is posted. Then its sweep deletes the row, with its media, thumbnails and files. A contact can also withdraw a status before the day ends. Both make the status disappear from `Status.sqlite`, and the store does not tell which one applies. Every other WhatsApp stream compares a full read of its store with the previous read, and deletes what WhatsApp no longer holds.

Thus `statuses` expires by `timestamp`. The snapshot differential gives a vanished status a `Retention` verdict with a horizon: the start of the scan, less the lifetime of one day, plus a margin of one hour. A status older than the horizon expired: it leaves the snapshot, and its row stays. A status younger than the horizon was withdrawn, and the source deletes it. The margin of one hour absorbs a WhatsApp clock that is different from the clock of this Mac. Thus a status that disappeared more than 23 hours after it was posted stays.

## Considered Options

- **Delete each status that the store no longer holds, as the other streams do.** Every status then leaves the import one day after it is posted.
- **Keep a status that disappeared after its day, and delete a status that disappeared before.** This option was selected.

## Consequences

- A status that the source did not load within its day is lost, with its file. To keep statuses, a watch must run within that day.
- The account's own statuses are archived (`is_archived` 1), not removed, so they stay in the store.
- The live check of 2026-10-12 saw WhatsApp delete four statuses 24 hours after they were posted. The next sync deleted nothing and kept all 14 statuses that it had loaded.
- Safari uses the same `Retention` policy. The two copies of `policyFor(horizon)` wait for a third consumer (backlog #2620).

## Sources

- Commit b1543924: "Statuses expire by timestamp: WhatsApp sweeps a contact's status a day after it is posted, so one that vanished later stays and one withdrawn sooner is deleted."
- Commit 01206d6d and backlog #2600: the deletion policies `ClosedWorld`, `Retention` and `Coverage`, with WhatsApp's statuses on `Retention`.
- Backlog #2620: the copied `policyFor(horizon)`.
