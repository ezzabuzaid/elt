# eca

A user wants to know when the data in a warehouse starts to match a condition, for example: "when my card purchases in the first 10 days of a month pass 200 JOD, tell me". An agent writes that condition as code. A host gives eca the warehouse, keeps a cursor for each rule, and acts on what eca gives. eca reads the warehouse at two positions for each step and keeps nothing.

## Language

**Rule**:
The host's own object with a condition. An outcome carries the rule back, so the host knows which rule it is about.
_Avoid_: Alert, monitor, automation, trigger (a SQL trigger is one form of an event)

**Warehouse**:
The data that the conditions read, as the host gives it to eca: its positions, and a reading as of each one. eca does not know where the data is or what holds it.
_Avoid_: Database, store, import (an import is one way a host keeps its data)

**Position**:
A commit of the warehouse where no pass is half done, as the warehouse names it, for example `<epoch>:<number>`. A position that the warehouse can no longer read is expired.
_Avoid_: Offset, version, commit (a commit inside a pass is not a position), checkpoint

**Reading**:
The warehouse as of one position, with `sql`, its handle, and `at`, the time that the reading stands for.
_Avoid_: Snapshot (a reading has one, but a snapshot alone can show half a pass), query, connection

**Cursor**:
One string that eca makes for each rule: the position that the rule's last evaluation read, and the time that it stood for. The host saves it with the matches, and gives it to the next evaluation.
_Avoid_: Offset, bookmark, state, keys

**Condition**:
Code that reads two readings, before and after, and gives what matches in after that did not match in before. The agent writes it. SQL is one part of a condition, not all of it.
_Avoid_: Query, filter, check, predicate

**Step**:
One pair of readings that a condition evaluates. In a step, only time moves, or only the data moves.
_Avoid_: Tick, diff, delta

**Evaluation**:
One walk of a rule, from its cursor over each position after it, step by step.
_Avoid_: Check, poll, tick, run (a rule does not run; its condition is evaluated)

**Match**:
One thing that a condition gives for a step: something that became true. The condition chooses its shape.
_Avoid_: Alert, instance, result, row, new match

**Outcome**:
What an evaluation gives for one rule: its matches and its new cursor; or the matches before a failure, the error and the cursor after the last good step; or the reason that its cursor expired.
_Avoid_: Event, result, report

**Expired**:
A cursor whose position the warehouse can no longer read, because it is older than the warehouse's retention or because a fresh run made the warehouse again. The host decides what to do.
_Avoid_: Stale, invalid, lost

**Host**:
The app that gives eca the warehouse, keeps the cursor of each rule, decides when to evaluate, and acts on the outcomes.
_Avoid_: Runner, server, app (in Context Compiler's hosts, app means the macOS application)
