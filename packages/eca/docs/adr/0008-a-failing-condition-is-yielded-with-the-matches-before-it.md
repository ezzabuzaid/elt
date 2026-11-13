# A failing condition is yielded with the matches before it

An agent writes each condition as code with SQL in it, so a condition can throw: a query names a table that does not exist, or the code cannot parse a row. Once, one condition that threw rejected the whole loop, and a host such as proactive stopped, so one broken rule silenced every notification.

Now `evaluate` evaluates each rule on its own. When a condition throws at a step of its walk, the rule's outcome is `{ rule, matches, error, cursor }`: the matches of the steps before the failure, the error, and the cursor after the last good step. The other rules of the call still run. The host saves the matches and the cursor as for any outcome, so the next evaluation goes on from the step that failed. A failure can pass: a dropped connection, a lock, or a row that a later commit corrects. Then nothing is lost, and nothing before the failure is evaluated again.

## Considered Options

- **The first failure rejects the evaluation.** One rule can stop all the others.
- **A failure keeps the rule at its old cursor.** Nothing is lost, but each evaluation walks again over the steps that succeeded, and a failure that stays blocks the matches before it too.
- **A `failed(rule, error)` callback.** A failure then goes through a second channel that the host must also wire.
- **A failure is an outcome, with the matches before it and the cursor after the last good step.** The host's one loop handles both, and it decides what a failure means: a log line, a notification, or nothing. This option was selected.

Superseded in part on 2026-11-13 (#4253) by [ADR 0010](./0010-eca-is-a-stateless-reader-over-warehouse-positions.md): the title was "A failing condition is yielded beside the new matches", and the failing rule kept the keys of its last evaluation.
