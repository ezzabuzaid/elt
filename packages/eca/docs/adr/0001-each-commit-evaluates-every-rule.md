# Each commit evaluates every rule

eca follows the Event–Condition–Action model of active databases (HiPAC, 1988). An event tells eca when to evaluate a condition. In eca, the event is a commit to the warehouse, and each commit evaluates every rule.

The first design made the event narrower. It recorded which tables each condition read, through the authorizer callback of SQLite, and a commit evaluated only the rules that read a table that the commit wrote. That routing is an optimization only. When eca evaluates every rule, the outcomes are the same, because eca compares the keys and yields only new matches. The routing also tied eca to SQLite, and it needed the host to report the table names that each commit wrote.

## Considered Options

- **The rule names its event: `changed('messages')`.** In the Messages import, `messages` is the name of the import and also the name of a stream. The name also repeats the SQL of the condition, and it can drift from it.
- **Events from the tables that the condition read.** Each commit evaluates fewer rules, but the outcomes are the same. It needs the authorizer of SQLite and a table name in each commit.
- **Time events: `daily('00:00', 'Asia/Amman')`.** Necessary for a window that closes without new data, and for a rule about data that did not come. The user removed them from the first version to keep the API small.
- **Each commit evaluates every rule.** This option was selected.

## Consequences

- A rule has no event of its own. A commit tells eca only that new data is there, not where.
- Each commit costs one evaluation of each rule. When this is too slow, a warehouse can report more, and eca can route again.
- A window that closes with no new data ends at the next commit, not at the time it closes.
