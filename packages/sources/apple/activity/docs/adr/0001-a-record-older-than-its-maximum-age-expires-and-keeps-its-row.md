# A record older than its maximum age expires and keeps its row

macOS keeps the activity of the user for about one month, and then drops it with no deletion. A snapshot diff that deletes each record that leaves the upstream would delete every row after one month. A user can also delete a record before that time, for example when they clear the Safari history.

Thus each stream declares `expiresBy`: `recordedAt` for a Biome stream, and `startedAt` for a knowledgeC stream. The source passes the deletion policy `Retention` with the earliest time that macOS still keeps: the start of the run, less the maximum age of the stream, plus one hour. A record that leaves the upstream after that time expires: its key leaves the snapshot, and its row stays. A record that leaves the upstream before that time is deleted. The maximum ages come from the BiomeLibrary of macOS: 28 days, `Notification.Delivery` 3 days, `Screenshots.Screenshot` 1 day, and knowledgeC's discoverability signals 730 days.

On 2026-10-05, each of the 18,305 age-pruning tombstones of the previous week was 28.000–29.03 days after its 28-day record. The deletions by the user were minutes old.

## Considered Options

- **Delete every record that leaves the upstream.** All rows go away after one month.
- **Keep every row.** A deletion by the user then stays in the destination.
- **Expire the records older than the maximum age less one hour, and delete the others.** This option was selected.

## Consequences

- The rows of dropped records are only in the destination. A rebuild or a cleared copy loses them.
- The snapshot keeps the `expiresBy` value of each key. Thus the state is limited to what macOS keeps.
- Each Biome stream also has a maximum number of events and a maximum size. A stream at its maximum prunes younger records, and the source deletes their rows (backlog item 2243).
- `devices` has no maximum age. It deletes each device that leaves `sync.db`.

Sources: commit f9cc0a57 (expiry by a horizon), commit 3e70cef1 (a read covers its records), commit 01206d6d (the deletion policy `Retention`); backlog items 2243 and 2246.
