# A new rule starts from a baseline

A user adds the rule "when my card purchases in days 1 to 10 of a month pass 200 JOD, tell me" on 15 October. October passed 200 JOD on 2 October. The user said that the rule must not report October, and that the rule is added all the same.

An import can be late. A host that did not run for some days imports the SMS of 2 October on 12 October. The user still wants to hear of October then. Thus the condition must judge the window by the time of the purchase (event time), not by the time of the evaluation (processing time). But a condition that uses event time finds October true on 15 October, and reports it.

eca solves both cases with a baseline. `add` evaluates the condition one time, keeps its matches, and reports no change. A rule then reports only what changes after it was added. A SQL trigger does the same: it does not fire for rows that were there before the trigger. A new Kafka consumer group with `auto.offset.reset=latest` also starts at the end and skips the older messages.

## Considered Options

- **The first evaluation reports, as a Prometheus alerting rule does.** The rule added on 15 October reports October. The user did not want that.
- **The condition gets the time the rule was added (`addedAt`).** Each condition must then compare its windows with `addedAt`. This is one more value in the context, and each author must remember it.
- **A baseline when the rule is added.** The library does it, so no condition can forget it. This option was selected.

## Consequences

- A rule added after a key started never reports that key. A rule added on 5 October, when October is already at 474 JOD, says nothing about October. It reports November when November passes 200 JOD.
- The baseline is in memory. A host that starts again and adds its rules again gives each rule a new baseline. See [ADR 0006](./0006-eca-keeps-no-state-across-restarts.md).
- A rule whose window is fixed in time and already over, for example "1 to 10 October 2026", is added and never reports.
