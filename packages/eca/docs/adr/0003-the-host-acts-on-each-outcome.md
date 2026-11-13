# The host acts on each outcome

The user wants an action when a condition starts to match, and the action is the user's own. eca can call that action, or it can give each outcome to the host, which then acts.

To call the action and to remember that it was called are two writes to two systems, and they cannot succeed or fail together. This is the dual-write problem. If the process stops between the two writes, the action happens again, or it is lost. The standard fix is a transactional outbox: one transaction keeps the action and the progress, and a relay delivers the action at least once. pg-boss does this with `send(name, data, { db })` in the transaction of the caller. The user decided that this is the problem of the host, not of eca.

Thus `evaluate` gives one outcome for each rule: its matches and its new cursor. The host saves both in one transaction of its own, for example the matches as outbox rows and the cursor beside them, and a relay acts on the rows. A stop before the transaction commits leaves the old cursor, so the next evaluation gives the same matches again; a stop after it loses nothing. A Kafka consumer that saves its offset with its output in one transaction works the same way.

## Considered Options

- **eca calls the action of each rule.** The agent writes the condition and the action together. eca then must make the call safe, which is the dual-write problem above.
- **eca has its own outbox and relay.** This adds a queue to eca before a host needs it.
- **eca yields each match, and the host moves past it.** This was the design of `watch` (ADR 0007). The host could not save a match and the progress of its rule in one transaction, because the progress was eca's keys in memory.
- **eca gives the matches and the cursor together, and the host saves both.** This option was selected.

Superseded in part on 2026-11-13 (#4253) by [ADR 0010](./0010-eca-is-a-stateless-reader-over-warehouse-positions.md): the title was "The host acts on each new match", and the host moved past each new match of `watch`.
