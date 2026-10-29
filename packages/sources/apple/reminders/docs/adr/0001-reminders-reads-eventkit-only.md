# Reminders reads EventKit only

Two APIs give reminders on macOS: the scripting interface of Reminders.app and EventKit. They use different identifiers. A source that reads both must match two identifier namespaces. The scripting interface also gives fields in a form that loses data: one due date and one alarm time for each reminder.

EventKit gives the start and due date components with their own calendar and time zone, each alarm with its location, the recurrence rules with all their selectors, and the account and list of each reminder. Thus `AppleRemindersSource` reads EventKit only. It does not call the scripting interface of Reminders, and it has no scripting fallback.

At first, the source called EventKit through the Objective-C bridge of JXA in `osascript`. Now `eventkit`, a compiled Swift helper of `@workspace/sdk-apple-eventkit`, reads the store one time for each read and writes one JSON document for each account, list and reminder. The Calendar source uses the same helper.

## Considered Options

- **The scripting interface of Reminders.app.** It has its own identifiers, and its dates and alarms lose data. It gives the flagged status and list emblems, which EventKit does not give.
- **The scripting interface with an EventKit fallback.** The source must then match two identifier namespaces.
- **EventKit only.** This option was selected.

## Consequences

- The source identity is `apple-reminders:eventkit`. The IDs are EventKit identifiers.
- The source needs full Reminders access. Calendar access and Automation access do not replace it.
- EventKit has no tags, flagged status, parent reminders, list groups or list emblems in its public API. The source does not export them, and it does not make values for them.
- The helper made a Reminders read faster: from 2.0 s to 0.07 s on this Mac.

## Sources

- f705856b: `docs/eventkit-reminders.md`, "Decision and design" and its table of the scripting fields and their EventKit form.
- 10d2b2ba: Calendar and Reminders read through a Swift EventKit helper.
