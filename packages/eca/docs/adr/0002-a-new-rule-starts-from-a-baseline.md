# A new rule starts from a baseline

A user adds the rule "when my card purchases in days 1 to 10 of a month pass 200 JOD, tell me" on 15 October. October passed 200 JOD on 2 October. The user said that the rule must not act for October, and that the rule is added all the same.

An import can be late. A host that did not run for some days imports the SMS of 2 October on 12 October. The user still wants the action for October then. Thus the condition must judge the window by the time of the purchase (event time), not by the time of the evaluation (processing time). But a condition that uses event time finds October true on 15 October, and acts.

eca solves both cases with a baseline. When the store does not know the id of a rule, `add` evaluates the condition one time, keeps its matches, and calls no action. A rule then acts only on commits after it was added. A SQL trigger does the same: it does not fire for rows that were there before the trigger. A new Kafka consumer group with `auto.offset.reset=latest` also starts at the end and skips the older messages.

## Considered Options

- **The first evaluation acts, as a Prometheus alerting rule does.** The rule added on 15 October acts for October. The user did not want that.
- **The condition gets the time the rule was added (`addedAt`).** Each condition must then compare its windows with `addedAt`. This is one more value in the context, and each author must remember it.
- **A baseline when the rule is added.** The library does it, so no condition can forget it. This option was selected.

## Consequences

- A rule added after a key started never acts for that key. A rule added on 5 October, when October is already at 474 JOD, says nothing about October. It acts for November when November passes 200 JOD.
- `add` with an id that the store knows takes no baseline. After a restart, the stored matches stay, and a commit that came while the host was down still starts its key.
- A rule whose window is fixed in time and already over, for example "1 to 10 October 2026", is added and never acts.
