# A rule wakes on commits to the tables its condition read

eca follows the Event–Condition–Action model of active databases (HiPAC, 1988). An event tells eca when to evaluate a condition. The first design had the rule name its event, for example `changed('messages')`. That name has two meanings. In the Messages import, `messages` is the name of the import and also the name of one of its 13 streams. "The source changed" is also too early: the Messages source sees a new SMS in `chat.db` before elt commits it to the import. A condition that is evaluated then reads the old data and misses the purchase.

The correct event is a commit to a table that the condition reads. The condition already names those tables in its SQL, so a second name in the rule can only drift from it. SQLite tells an authorizer callback each table that a statement reads, also through a view, when it prepares the statement. eca records these reads in each evaluation. When the host reports a commit to `raw_messages` in the import `messages`, eca evaluates only the rules whose last evaluation read that table. This is dependency tracking, as a spreadsheet recalculates a cell when a cell that it uses changes.

A probe on the real Messages import showed the reads of the spend query as `messages.raw_messages (via messages)` and `messages.messages`.

## Considered Options

- **The rule names its event: `changed('messages')`.** The name means the import or the stream, and the source sees a change before the import has it. The name also repeats the SQL and can drift from it.
- **Time events: `daily('00:00', 'Asia/Amman')`.** Necessary for a window that closes without new data, and for a rule about data that did not come. The user removed them from the first version to keep the API small.
- **Events from the reads of the condition.** This option was selected.

## Consequences

- A rule has no `on`. Its events are the reads of its last evaluation.
- eca needs SQLite. Postgres has no authorizer callback, so a Postgres import needs another way to know the reads.
- Each evaluation gets a new tag store. A tag store keeps the statements that it prepared, and SQLite calls the authorizer only when it prepares a statement. A reused statement reports no reads, and the rule then never wakes again.
- The reads of a view come from its tables. The host reports the tables that elt writes, for example `raw_messages`, not the view `messages`.
- A window that closes with no new data ends at the next commit, not at the time it closes.
