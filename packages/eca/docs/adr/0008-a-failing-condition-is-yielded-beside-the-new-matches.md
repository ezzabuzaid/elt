# A failing condition is yielded beside the new matches

An agent writes each condition as code with SQL in it, so a condition can throw: a query names a table that does not exist, or the code cannot parse a row. Before this decision, one condition that threw rejected `watch`. The rules after it were not evaluated for that commit, and a host such as proactive stopped, so one broken rule silenced every notification.

Now `watch` evaluates each rule on its own. When a condition throws, `watch` yields a failure, `{ rule, error }`, and goes on with the next rule. The failing rule keeps the keys of its last evaluation, so the next commit evaluates it again. A match that the failure hid is new then, and it is yielded. elt's `Pipeline.watch` also keeps the other connections watching when one fails, but its failed connection stops. A failed rule is evaluated again, because a failure can pass: a dropped connection, a lock, or a row that a later commit corrects.

## Considered Options

- **The first failure rejects `watch`.** One rule can stop all the others. This was the behavior before.
- **A `failed(rule, error)` callback on `watch`.** The stream holds only new matches, but a failure goes through a second channel that the host must also wire.
- **A failure is yielded in the stream.** The host's one loop handles both, and it decides what a failure means: a log line, a notification, or nothing. This option was selected.

## Consequences

- `watch` yields `NewMatch | Failure`. A host tells them apart with `'error' in item`.
- A condition that always throws yields a failure at every commit, until the host removes or fixes the rule.
- A throw in a rule's baseline still rejects `add`, and the rule is not added.
- A warehouse whose `commits` rejects still ends `watch` with that error, because no rule caused it.
