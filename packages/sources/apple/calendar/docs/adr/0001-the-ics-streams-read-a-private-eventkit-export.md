# The ICS streams read a private EventKit export

The public EventKit API gives no attachments, no recurrence overrides and no conference data of an event. No public macOS API gives them. The iCalendar data of an item has all of them: `ATTACH`, `RRULE`, `EXDATE`, `RECURRENCE-ID`, and vendor properties such as `X-GOOGLE-CONFERENCE` and `X-MICROSOFT-*`.

`EKEventStore` has a private method that exports the iCalendar data of items: `ICSDataForCalendarItems:preventLineFolding:`, or `ICSDataForCalendarItems:options:`. Thus three streams read that export and keep its tree as scalar rows: `icsComponents`, `icsProperties` and `icsParameters`. `icsAttachments` reads the `ATTACH` properties of the same export.

A private API can change or disappear in a macOS update. Thus the helper checks for the method before it calls it. When the method is missing, the copy fails with `CalendarIcsUnavailableError`. It does not load an empty export, which would delete the rows. The helper exports each item one time for each read, and only when an ICS stream is selected.

`DTSTAMP` is the time of the export, so it changes at each read. The streams do not include it. Without it, a second run with no changes writes nothing.

## Considered Options

- **Public EventKit only.** The source then gives no attachments, recurrence overrides or conference data.
- **The GUI export of Calendar (`.ics`, `.icbu`).** It needs a person, and the schema of the `.icbu` database is not a public API.
- **The private export, checked before each use.** This option was selected.

## Consequences

- A macOS version without the method fails the ICS copies. The other streams use public EventKit, and they still load.
- `CalendarIcsUnavailableError` tells the user to select only the public streams.

## Sources

- 579568a4: export Calendar ICS components, properties and parameters, through a private EventKit API that is feature-detected. `DTSTAMP` is omitted.
- 10d2b2ba: the Swift helper exports ICS only when an ICS stream is selected, one time for each item, without pages.
