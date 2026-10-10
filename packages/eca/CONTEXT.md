# eca

A user wants an action when the data in an import starts to match a condition, for example: "when my card purchases in the first 10 days of a month pass 200 JOD, tell me". An agent writes that condition as code. A host keeps the imports current and tells eca about each commit. eca runs the condition again and tells the action what changed.

## Language

**Rule**:
A condition, an action, and an id that names the rule across restarts.
_Avoid_: Alert, monitor, automation, trigger (a SQL trigger is one form of an event)

**Event**:
What makes eca evaluate a condition again: a commit to a table that the condition read. eca has no time events.
_Avoid_: Trigger, signal, change (a change is what the action gets)

**Condition**:
Code that reads the imports through SQL and returns the matches that are true now. The agent writes it. SQL is one part of a condition, not all of it.
_Avoid_: Query, filter, check, predicate

**Evaluation**:
One run of a condition.
_Avoid_: Check, poll, tick, run (a rule does not run; its condition is evaluated)

**Match**:
One thing that a condition found true in an evaluation: a key and its data.
_Avoid_: Alert, instance, result, row

**Key**:
The name of a match across evaluations. The action hears that a key started one time, until the key ends. The condition chooses the key, for example the month.
_Avoid_: Id (an id names a rule), dedup key, fingerprint (eca uses the fingerprint of the data to find a change)

**Change**:
How a match moved since the previous evaluation: started, changed, or ended. eca gives each change to the action.
_Avoid_: Event (an event makes eca evaluate), transition, notification

**Started**:
A key is in this evaluation and was not in the previous one.

**Changed**:
A key is in both evaluations, and its data is different.
_Avoid_: Updated

**Ended**:
A key was in the previous evaluation and is not in this one.
_Avoid_: Resolved, cancelled, expired

**Action**:
The code of the user that eca calls with each change.
_Avoid_: Handler, callback, receiver, contact point, X

**Baseline**:
The first evaluation of a rule that the store does not know. eca keeps its matches and calls no action. Thus a rule acts only on commits after it was added.
_Avoid_: Seed, snapshot (elt uses snapshot for a full read), initial run

**Import**:
A SQLite file that elt writes and eca only reads. The host gives each import a name, for example `messages`. A condition reads its tables by that name, for example `messages.messages`.
_Avoid_: Source (an elt source reads an app), database, connector

**Commit**:
New data that the host made durable in tables of an import. The host tells eca which tables with `committed`.
_Avoid_: Sync, update, load, pass (an elt pass can make many commits)

**Read**:
A table of an import that a condition read in its last evaluation, also through a view.
_Avoid_: Dependency, subscription, watch

**Store**:
The SQLite file in which eca keeps the matches and the reads of each rule.
_Avoid_: State, checkpoint (elt uses checkpoint), cache

**Host**:
The app that makes the `Eca`, gives it the imports, adds the rules, and tells it about each commit.
_Avoid_: Runner, server, app (in the Apple hosts, app means the macOS application)
