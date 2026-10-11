# The host acts on each new match

The user wants an action when a condition starts to match, and the action is the user's own. eca can call that action, or it can give each new match to the host, which then acts.

To call the action and to remember that it was called are two writes to two systems, and they cannot succeed or fail together. This is the dual-write problem. If the process stops between the two writes, the action happens again, or it is lost. The standard fix is a transactional outbox with a job queue: one transaction keeps the new match and an outbox row, and a relay delivers it at least once. pg-boss does this with `send(name, data, { db })` in the transaction of the caller. The user decided that this is the problem of the host, not of eca.

Thus `watch` yields each new match, and the loop of the host is the action. The host pulls the new matches, as it pulls the passes of `Pipeline.watch` in elt. A rule takes its new keys only when the host moves past its last new match. A Kafka consumer moves its offset in the same way, after it processed a message.

## Considered Options

- **eca calls the action of each rule.** The agent writes the condition and the action together. eca then must make the call safe, which is the dual-write problem above.
- **eca has its own outbox and relay.** This adds a queue to eca before a host needs it.
- **`watch` yields each new match, and the host acts.** This option was selected.

## Consequences

- eca has no action type. A new match carries the rule object that the host added, so the host knows what to do.
- A new match that the host did not move past comes again to its next watch. This includes the later new matches of the same rule from the same commit.
- eca retries nothing. A host that must deliver each new match keeps it safe, for example in its own outbox.
