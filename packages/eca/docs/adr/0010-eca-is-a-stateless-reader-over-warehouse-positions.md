# eca is a stateless reader over warehouse positions

Datahub's staffing alerts did eca's job by hand, because eca had three gaps (#4253):

1. A restart missed a key that stopped matching and then matched again. A host saved the keys of a rule (ADR 0009), but keys tell only what matched at the last evaluation, not what happened between two of them.
2. A rule could not be removed, paused or resumed: eca held each rule's keys in memory.
3. No single evaluation gave its result in a form that the host could save in its own transaction, with the actions.

The three gaps have one cause. The event of eca was empty: a commit said that something changed, not what. So eca compared each evaluation with the one before it, and that needed keys and a store.

Now the warehouse gives eca what SQL Server change tracking gives a client: `CHANGE_TRACKING_CURRENT_VERSION`, `CHANGETABLE(… @since)` and `MIN_VALID_VERSION`. elt's destinations number each commit, keep a history of each row that a commit changed or removed, and read the warehouse as of a position, as a SQL:2011 system-versioned table does (`FOR SYSTEM_TIME AS OF`). eca reads the warehouse at two positions and keeps nothing.

## Decision

- **Port.** `Warehouse<Sql>` has `stable(after)`, the positions after one, and `read(position?)`, a reading `{ sql, position, at }` that eca disposes. Each gives `{ expired }` for a position that the warehouse can no longer read.
- **Condition.** `evaluate(before, after)` gives what matches in `after` and did not in `before`. eca does not compare matches; the condition does, with its own idea of what is the same.
- **Cursor.** One string that eca makes: the position of a rule's last evaluation and the time that it stood for. `start()` gives the cursor of a new rule: the newest position, now, so a rule matches only what becomes true after it. This takes the place of the baseline of ADR 0002.
- **Walk.** `evaluate(rules)` walks each rule from its cursor over each position after it. In each step one thing moves: time, up to the commit of the next position, with the data as it was; then the data, at that time; and last, time up to now. A key that stops and matches again between two evaluations matches again (gap 1). A time that passes is read with the data current then: a deadline that passes while a task is open matches, also when a later position closed the task. A step that moves nothing is skipped. At most two readings are open.
- **Outcome.** One for each rule: its matches and its new cursor; or, when the condition throws at a step, the matches of the steps before it, the error and the cursor after the last good step; or `{ expired }`. The host saves the matches and the cursor in one transaction of its own (gap 3).
- **No state.** A rule the host does not give is not evaluated. Remove, pause and resume are what the host keeps (gap 2).
- **Expiry is a value.** A cursor older than the warehouse's retention, or of a warehouse that a fresh run made again, gives `{ rule, expired }` with the reason. The host decides; eca never skips it silently.

## Considered Options

- **Keep keys, and give them back (ADR 0009).** It cannot tell what happened between two evaluations, and the host must store the keys apart from the actions.
- **A change log of the tables each rule reads.** A condition reads the whole warehouse, any table or view, so a log of named tables repeats the condition's SQL and can drift from it. Ezz decided that eca names no tables (2026-11-11).
- **eca stores the matches of each rule.** The store is then eca's, and gap 3 stays: the host cannot save eca's store and its own actions in one transaction.
- **Positions and readings from the warehouse, and one cursor for each rule that the host keeps.** This option was selected.

## Consequences

- A warehouse must number its commits and read as of a position. elt-sqlite does it with TEMP views over a history table; elt-postgresql with reader views that read `elt.position`.
- Each step evaluates the condition twice: once for each reading. A condition that reads much data reads it twice for each step.
- A walk after a long pause evaluates each position that the pause covered, within the warehouse's retention.

Sources: backlog #4253; elt-sqlite ADR 0009; the plan of 2026-11-11.
