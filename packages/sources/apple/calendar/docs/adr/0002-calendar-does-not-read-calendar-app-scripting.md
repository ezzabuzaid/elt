# Calendar does not read the scripting interface of Calendar.app

The source once read two streams through the scripting interface of Calendar.app: `eventMetadata` and `excludedDates`. Each property cost approximately 55 ms for each event, in a batch or not. That was approximately 40 minutes of a run of 62 minutes. A live comparison on 2,786 items showed that the ICS export already has all that these streams held: `EXDATE` covered 127 series, and scripting covered 67.

The source also read the description of each calendar through scripting, so it needed Automation access and started Calendar.app. The private `notes` property of `EKCalendar` holds the same description that Calendar.app shows.

Thus the source reads no scripting interface. The ICS streams give the recurrence data, and the helper reads `notes` for the calendar description.

## Considered Options

- **Keep the scripting streams.** They are slow, and they add nothing that the ICS export does not have.
- **Read EventKit and its ICS export only.** This option was selected.

## Consequences

- A full Calendar export took approximately 6.5 minutes after the change, against 62 minutes before.
- The source needs no Automation access, and it never starts Calendar.app.
- The helper checks for the `notes` property, and the read fails when a macOS version does not have it.

## Sources

- 700541fa: drop the `eventMetadata` and `excludedDates` streams. Scripting cost approximately 55 ms for each event and property, and the ICS export has all of their data.
- 10d2b2ba: Calendar descriptions come from the private `notes` property of `EKCalendar`, so Calendar needs no Automation access and does not start Calendar.app.
