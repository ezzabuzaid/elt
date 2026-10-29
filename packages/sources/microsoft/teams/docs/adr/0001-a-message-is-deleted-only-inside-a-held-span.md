# A message is deleted only inside a held span

The Teams app keeps every conversation, but only the messages that it loaded. The client records in `syncstates` the span that it holds of each conversation, of each channel thread that the user opened, and of each feed. When the client prunes its cache, it moves the start of a span. A message can leave the store for two reasons: a user deleted it in Teams, or the client pruned it. The store does not tell which reason applies.

Thus the source deletes a message only when the message is gone from inside a span that covers it. A channel reply is covered only by the span of its thread. A message outside all spans is unknown. It stays in the snapshot, and a later read that covers its place judges it again. Call logs, activities and saved messages are messages of feeds and follow the spans of their feeds.

The first version forgot a key that left the snapshot outside every span. When Teams dropped a thread, a reply was deleted, and Teams loaded the thread again, no read could delete the reply's row (backlog #2600). The snapshot differential now gives each vanished key a verdict from a deletion policy. Teams passes `Coverage`, as Slack does.

## Considered Options

- **Delete each message that the store no longer holds.** A message that the client pruned is then deleted, also when it still exists in Teams.
- **Never delete a message.** A message that a user deleted in Teams then stays.
- **Delete a message only inside a span that covers it, and judge a message outside every span again at a later read.** This option was selected.

## Consequences

- A reply that was deleted while the app did not hold its thread is deleted when the app loads the thread again.
- A span with a gap in it covers nothing.
- `people`, `meetings` and `searches` have no span, so they delete nothing.
- Reactions, mentions, files, links and quotes follow their message.

## Sources

- Commit c0694480: the Teams source, with deletions only inside a span.
- Commit 01206d6d and backlog #2600: a key outside every span stays in the snapshot until a read can judge it.
