# eca

A user wants to know when the data in a warehouse starts to match a condition, for example: "when my card purchases in the first 10 days of a month pass 200 JOD, tell me". An agent writes that condition as code. A host gives eca the warehouse and acts on what eca reports. eca evaluates the conditions at each commit to the warehouse, and it reports each change of their matches.

## Language

**Rule**:
A condition and an id. The id names the rule in each of its changes.
_Avoid_: Alert, monitor, automation, trigger (a SQL trigger is one form of an event)

**Event**:
A commit to the warehouse. Each event makes eca evaluate every rule. eca has no time events.
_Avoid_: Trigger, signal, change (a change is what eca reports)

**Warehouse**:
The data that the conditions read, as the host gives it to eca: a read-only handle for the conditions, and its commits. eca does not know where the data is or what holds it.
_Avoid_: Database, store, import (an import is one way a host keeps its data)

**Commit**:
New data that is made durable in the warehouse. The warehouse reports each commit to eca.
_Avoid_: Sync, update, load, pass (an elt pass can make many commits), acknowledgement

**Condition**:
Code that reads the warehouse and returns the matches that are true now. The agent writes it. SQL is one part of a condition, not all of it.
_Avoid_: Query, filter, check, predicate

**Evaluation**:
One run of a condition.
_Avoid_: Check, poll, tick, run (a rule does not run; its condition is evaluated)

**Match**:
One thing that a condition found true in an evaluation: a key and its data.
_Avoid_: Alert, instance, result, row

**Key**:
The name of a match across evaluations. The host hears that a key started one time, until the key ends. The condition chooses the key, for example the month.
_Avoid_: Id (an id names a rule), dedup key, fingerprint

**Change**:
How a match moved since the previous evaluation: started, changed, or ended. eca reports each change to the host.
_Avoid_: Event (an event makes eca evaluate), transition, notification

**Started**:
A key is in this evaluation and was not in the previous one.

**Changed**:
A key is in both evaluations, and its data is different.
_Avoid_: Updated

**Ended**:
A key was in the previous evaluation and is not in this one.
_Avoid_: Resolved, cancelled, expired

**Baseline**:
The first evaluation of a rule, when the host adds it. eca keeps its matches and reports no change. Thus a rule reports only what changes after it was added. The baseline is in memory, so a rule that the host adds again starts from a new baseline.
_Avoid_: Seed, snapshot (elt uses snapshot for a full read), initial run

**Watch**:
The host's loop over the changes: eca yields each change, and the host asks for the next one.
_Avoid_: Subscribe, listen, observe (an elt source observes its upstream)

**Move past**:
The host asks for the next change. A rule takes its new matches only after the host moved past its last change. A change that the host did not move past comes again to its next watch.
_Avoid_: Acknowledge, ack, commit (a commit is new data in the warehouse)

**Host**:
The app that gives eca the warehouse, adds the rules, watches the changes, and acts on them.
_Avoid_: Runner, server, app (in the Apple hosts, app means the macOS application)
