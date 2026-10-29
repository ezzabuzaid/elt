# A message is deleted only inside a held range

The Slack app keeps every conversation that it knows, but only the messages that it loaded. The client record names the held ranges of each conversation. A message can leave the client record for two reasons: the user deleted it in Slack, or the app dropped it from its cache. The store does not tell which reason applies.

Thus the source deletes a message only when the message is gone from inside a held range, or when the client marks it `isNonExistent`. A message outside all held ranges stays in the snapshot. A later read that covers its range again judges it again, and deletes it if the app no longer holds it. Reactions, attachments and files follow their message.

The first version forgot a key that left the snapshot outside every held range. Then a later read that covered the range again could not delete the row, because the snapshot no longer had the key (backlog #2600). The snapshot differential now gives each vanished key a verdict from a deletion policy. Slack passes `Coverage`: a key inside a held range is deleted, and a key outside every held range is unknown and stays in the snapshot.

## Considered Options

- **Delete each message that the client record no longer holds.** A message that the app dropped from its cache is then deleted, also when it still exists in Slack.
- **Never delete a message.** A message that the user deleted in Slack then stays.
- **Delete a message only inside a held range, and judge a message outside every held range again at a later read.** This option was selected.

## Consequences

- A deleted message stays until a read covers its range again.
- Streams without held ranges delete nothing: `threadReplies`, `files`, `fileShares`, `listRecords`, `userGroupMemberships` and `downloads`.
- A pin is deleted only from a pin list that the client has loaded fully.
- The Microsoft Teams source has the same rule for the spans that its client holds.

## Sources

- Commit 34ba0e0f: the source deletes messages only inside a held range.
- Commit d5d3411a: pins, downloads and user group memberships.
- Commit 01206d6d and backlog #2600: a key outside every held range stays in the snapshot until a read can judge it.
