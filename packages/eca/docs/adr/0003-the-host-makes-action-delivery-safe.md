# The host makes action delivery safe

eca keeps the matches of a rule in its store, and it calls the action. These are two writes to two systems, and they cannot succeed or fail together. This is the dual-write problem:

- eca calls the action, then saves the matches, and the process stops between the two. The next commit gives the same change again.
- eca saves the matches, then calls the action, and the process stops between the two. The action never gets the change.

The standard fix is a transactional outbox. One transaction keeps the change and a row in an outbox table. A relay calls the action and deletes the row when the action succeeds. Delivery is then at least once, and the action skips a change that it saw before, by the id of the change. A job queue does the retries, the backoff and the dead letters. pg-boss supports this: `send(name, data, { db })` puts a job in the transaction of the caller. But pg-boss needs Postgres, and the Apple hosts use SQLite.

The user decided that the host owns this problem, not the library. The first version of eca handles only the happy path.

## Considered Options

- **eca uses pg-boss.** It needs Postgres, and the Apple hosts have no server.
- **eca has its own outbox and relay.** This adds a queue to the library before a host needs it.
- **eca calls the action and then saves. The host makes delivery safe.** This option was selected.

## Consequences

- eca saves the matches of a rule only after its action accepted each change. When an action throws, `committed` rejects, and the next commit gives the changes of that evaluation again, also those that the action already accepted.
- Nothing retries an action before the next commit.
- An action must accept a change that it saw before.
