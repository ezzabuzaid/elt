# The host decides when a rule is evaluated

eca follows the Event–Condition–Action model of active databases (HiPAC, 1988). An event tells eca when to evaluate a condition. The first design made the event a commit to the warehouse, and each commit evaluated every rule.

Since [ADR 0010](./0010-eca-is-a-stateless-reader-over-warehouse-positions.md), a rule has a cursor, and an evaluation walks from it over each position of the warehouse after it. An evaluation after one position, or after a hundred, gives the same matches. So when to evaluate no longer changes what a rule finds; it changes only when the host hears of it. Thus the host decides: after each pass, on a timer, or when a user asks. eca has no `watch` and no events of its own.

A time that passes is an event too: a deadline passes with no new data. An evaluation with no new position is one step in which only time moves, so a host that evaluates on a timer hears of a deadline once, at the first evaluation after it.

## Considered Options

- **The rule names its event: `changed('messages')`.** In the Messages import, `messages` is the name of the import and also the name of a stream. The name also repeats the SQL of the condition, and it can drift from it.
- **Events from the tables that the condition read.** Each evaluation reads fewer rules, but the outcomes are the same. It needs the authorizer of SQLite and a table name in each commit.
- **eca watches the warehouse, and each commit evaluates every rule.** This was the first design. It ties eca to a loop of its own, and a rule that is not in the loop cannot be evaluated.
- **Time events in eca: `daily('00:00', 'Asia/Amman')`.** The host's timer does the same, and a step in which only time moves reads it.
- **The host evaluates when it wants.** This option was selected.

Superseded in part on 2026-11-13 (#4253) by [ADR 0010](./0010-eca-is-a-stateless-reader-over-warehouse-positions.md): the title was "Each commit evaluates every rule".
