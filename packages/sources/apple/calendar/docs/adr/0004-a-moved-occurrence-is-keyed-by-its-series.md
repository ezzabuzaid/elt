# A moved occurrence is keyed by its series

The `eventId` of an occurrence is `[calendarId, calendar item, original occurrence date]`. EventKit gives a moved (detached) occurrence its own calendar item. Thus its `eventId` changed when a person moved it. The copy deleted the old row and added a new one, and a reader saw a moved meeting as cancelled.

The external identifier of a detached item is the iCalendar UID of the series, with `/RID=<original start>` added. Thus the helper finds the item of the series: the one item in the same calendar with recurrence rules under that UID. The `eventId` of the occurrence uses that series item. If there is not exactly one such item, the occurrence keeps its own item. `externalId` drops the `/RID=` suffix, so all occurrences of a series have the same `externalId`. The occurrence keeps its own `calendarItemId` and its own ICS export.

The helper reads in windows of one year. It wrote an occurrence that spans two windows two times. Now it writes each occurrence only in the first window that it overlaps.

## Considered Options

- **Key the occurrence by its own item.** A move then deletes its row.
- **Export each series one time, with all moved occurrences.** Nobody checked that each account keeps every moved occurrence in the export of its series, so this could lose data.
- **Key the occurrence by the item of its series.** This option was selected.

## Consequences

- A moved occurrence keeps its row.
- An occurrence that spans two read windows loads one time.

## Sources

- 03a350e1 (#2213, #2208): a moved occurrence keeps its row, and an occurrence across a read window loads once. Verified live on macOS 27 with iCloud.
