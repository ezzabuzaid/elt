# @workspace/source-apple-calendar

An ELT source for the calendars on this Mac: accounts, calendars, event occurrences in a date range, and their attendees, alarms, recurrence rules and iCalendar data. It reads EventKit through `CalendarStore` from `@workspace/sdk-apple-eventkit`, which runs a compiled Swift helper. It does not use Calendar.app or its scripting. Only attachment files can use the network, through a fetcher that you give.

```ts
import { fileURLToPath } from 'node:url';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { CalendarStore } from '@workspace/sdk-apple-eventkit';
import { AppleCalendarSource } from '@workspace/source-apple-calendar/apple-calendar-source';

const source = new AppleCalendarSource({
  store: new CalendarStore(
    fileURLToPath(
      import.meta.resolve('@workspace/sdk-apple-eventkit/eventkit-helper'),
    ),
  ),
  startAt: '2026-09-01T00:00:00.000Z',
  endAt: '2026-10-01T00:00:00.000Z',
});
const destination = new SQLiteDestination({ path: './calendar.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'apple-calendar',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './calendar-state.sqlite',
      }),
      steps: [source.calendars, source.events, source.attendees].map(
        (stream) =>
          new Copy(stream, destination.table(stream.name), {
            id: stream.name,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
      ),
    }),
  ],
}).run();
```

To narrow the import, give `scope` with `accountIds` or `collectionIds` (calendar IDs). To download remote attachment files, give `attachments` (see [Attachment files](#attachment-files)).

## The EventKit helper

`CalendarStore` runs `eventkit`, a compiled Swift helper ([helper](../../../sdks/apple/eventkit/src/helper)). The Nx target `sdk-apple-eventkit:helper` builds it as a universal (arm64 and x86_64) binary into `packages/sdks/apple/eventkit/dist/eventkit-helper`. The package exports it as `@workspace/sdk-apple-eventkit/eventkit-helper`. The host decides which copy runs: each store takes the path of the helper.

- `eventkit read '<json request>'` writes one JSON document on each line (account, calendar, occurrence, ICS export, reminder).
- `eventkit watch events|reminders` writes `changed` for each store change.

One read runs one helper process for all selected streams. The helper gives the values of EventKit. The store keeps the accounts and calendars in the requested scope, and it lists the attendees and alarms of each item in content order, because EventKit changes their order between processes. The source makes the rows: IDs, ISO timestamps and positions.

The `calendars` stream reads `description` from the private `notes` property of `EKCalendar`, which is the description that Calendar.app shows. A calendar without one exports an empty string. The helper checks for the property, and the read fails when a macOS version does not have it. Thus the source needs no Automation access, and it never starts Calendar.app ([ADR 0002](./docs/adr/0002-calendar-does-not-read-calendar-app-scripting.md)).

## Access

The source needs macOS 27 and full Calendar access for the process that runs the export. macOS gives access to the app that is responsible for the process, for example the terminal.

The first read asks for access if the user did not decide yet or gave write-only access. It asks through `osascript`, because macOS shows no prompt for the request of the helper itself. It waits up to 30 seconds. The grant goes to the terminal or app that runs the export. If access is denied, restricted or still pending, the helper writes `CALENDAR_UNAVAILABLE`, and the read fails with `CalendarUnavailableError`. This error keeps the native error as its `cause` and tells how to give access. A sandbox can block access also when macOS gives the permission. A permission failure never becomes an empty export.

## The ICS streams

The `icsComponents`, `icsProperties` and `icsParameters` streams read the iCalendar export of each item through a **private** EventKit API: `ICSDataForCalendarItems:preventLineFolding:` of `EKEventStore`, or else `ICSDataForCalendarItems:options:`. The helper exports each item one time, and only when an ICS stream is selected. It checks for the method first. If a macOS version does not have it, the copy fails with `CalendarIcsUnavailableError`. It does not load an empty export. An export without an event component also fails. A macOS update can remove or change this API. If that is a problem, select only the public streams ([ADR 0001](./docs/adr/0001-the-ics-streams-read-a-private-eventkit-export.md)).

## Streams

All eleven streams support full refresh and snapshot incremental (`append_dedup` with the key `id`, no `cursorField`; see [snapshot streams](../../../elt/README.md#snapshot-streams)). They work with inferred SQLite tables. A related collection whose members have their own fields is a separate stream of rows.

| Stream                 | Contents                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`             | EventKit sources: identifier, name, native source type, delegate flag.                                                                                                                                                                                                                                                                                        |
| `calendars`            | Identifier, `accountId`, name, description, native type, write, subscription and immutability flags, sRGB components, supported availability and entity masks.                                                                                                                                                                                                |
| `events`               | Event occurrences that overlap the range: native identifiers, `calendarId`, title, body, location, URL, start, end, all-day dates, time zone, creation and modification dates, original occurrence date, detached flag, status, availability, birthday contact identifier, geographic location.                                                               |
| `attendees`            | `eventId`, position, participant name and URL, native status, role and type, current-user flag. `kind` tells attendees from the organizer.                                                                                                                                                                                                                    |
| `alarms`               | `eventId`, position, native alarm type, relative offset in seconds, absolute date, email, sound, proximity and geographic location.                                                                                                                                                                                                                           |
| `recurrenceRules`      | `eventId`, position, calendar identifier, frequency, interval, first weekday, end date and occurrence count.                                                                                                                                                                                                                                                  |
| `recurrenceRuleValues` | `ruleId`, `eventId`, component and position, integer value, weekday ordinal (optional). It keeps weekdays, days of the month and the year, weeks of the year, months, and set positions.                                                                                                                                                                      |
| `icsComponents`        | One row for each iCalendar component of a native item (`VCALENDAR`, `VEVENT`, `VALARM`, `VTIMEZONE`, …): `id` `[calendarId, calendarItemId, path]`, `parentId`, `position`, `name`, `uid`, the raw `recurrenceId` with its `recurrenceIdTimeZone` (TZID), and `eventId` when it is exact (the master of an event that does not repeat).                       |
| `icsProperties`        | Each property except `DTSTAMP`, with its raw value: `componentId`, `position`, `name`, `value`. This includes `ATTACH`, `RRULE`, `EXDATE`, `RECURRENCE-ID`, `URL`, and vendor properties such as `X-GOOGLE-CONFERENCE` and `X-MICROSOFT-*`.                                                                                                                   |
| `icsAttachments`       | One row for each `ATTACH`: `uri` (raw), `filename` (`X-APPLE-FILENAME` or `FILENAME`), `formatType` (`FMTTYPE`), `inline`. This stream can give the file. The source decodes inline base64 content locally. The `attachments` fetcher that you give to `AppleCalendarSource` downloads remote references. A file that the fetcher cannot get loads as `null`. |
| `icsParameters`        | One row for each parameter value: `propertyId`, `componentId`, `position`, `valuePosition`, `name`, `value` (for example `ATTACH;FMTTYPE`, `ATTACH;FILENAME`, `DTSTART;TZID`).                                                                                                                                                                                |

Native enums and bitmasks stay integers. Missing optional values stay `null`. A recurrence count of zero sets no count limit. The `jsonSchema` of each stream gives the details of its schema.

## Dates and occurrence identity

`startAt` and `endAt` are required canonical UTC ISO timestamps with `startAt < endAt`. They select the half-open interval `[startAt, endAt)`. An event that overlaps the interval is included. An event with no duration is included when its start is in the interval. The range is not part of the source identity (`apple-calendar:eventkit`). Thus an incremental copy can move its window between runs, and the occurrences that leave the window are deleted. Construction, discovery and preflight do no native read.

EventKit expands recurrence and applies the exceptions of deleted and rescheduled occurrences. The helper queries in windows of 365 days or less, in one process, because EventKit cuts a query that is longer than four years and reports nothing. An occurrence that spans two windows loads one time. The source does not read a range without an end, because a recurring series can have no end.

`startAt`, `endAt` and the other timestamps keep native instants as UTC strings. For all-day events, `startDate` and `endDate` keep the local Gregorian dates in the default time zone of EventKit. `endDate` is **inclusive**: it is the last day of the event. EventKit keeps an all-day event as ending one second before the next local midnight. A live probe on **2026-09-24** (macOS 26.6.2, Asia/Amman) saved a one-day and a two-day all-day event from 25 September. They exported `endAt` `2026-09-25T20:59:59.000Z` with `endDate` `2026-09-25`, and `2026-09-26T20:59:59.000Z` with `endDate` `2026-09-26`. Both events had a null `timeZone`. The probe deleted both events, and a new read showed that they were gone. For a half-open range, add one day to `endDate`. A null `timeZone` stays null, and the source does not replace it with UTC. Timed events have null date-only fields.

The event `id` (also given as `eventId`) is the calendar identifier, the local calendar item identifier of the series, and the original occurrence date for repeating and detached events. It uses the native original date, not the rescheduled start. The key of an all-day occurrence uses a calendar date. EventKit gives a moved (detached) occurrence its own item. The external identifier of that item is the iCalendar UID of the series, with `/RID=` and its original start added. The helper keys it by the item of its series: the one item in the same calendar with recurrence rules under that UID. If there is not exactly one such item, it keeps the own item of the occurrence ([ADR 0004](./docs/adr/0004-a-moved-occurrence-is-keyed-by-its-series.md)). A live probe on **2026-10-09** (macOS 27, iCloud) moved the second of three weekly occurrences. It came back as item `04218C49…` with external identifier `C61EA281…/RID=758268000` next to the series item `51A2B869…`. `calendarItems(withExternalIdentifier:)` on the UID without the suffix gave only the series item. Native event identifiers and external identifiers stay separate fields. `externalId` drops the `/RID=` suffix, so all occurrences of a series have the same `externalId`. EventKit identifiers can change after moves or full server syncs. Thus these are local extraction identities, not permanent IDs across devices. A child ID adds the collection kind or component and the position. It identifies a snapshot row, not a native object with a stable identity.

The ICS streams give the recurrence data of each item. The `UID`, `SEQUENCE`, raw `RRULE` and `EXDATE` of each native item are `icsProperties` rows. The `TZID` of an `EXDATE` is an `icsParameters` row. The `VEVENT` of a detached item has the `UID` of its series and a `RECURRENCE-ID`. Public EventKit also gives the structured rules in `recurrenceRules` and `recurrenceRuleValues`. The helper exports the iCalendar data of each native item one time for each read, without pages.

The source does not read the scripting interface of Calendar. A live comparison on **2026-09-25** (macOS 26.6.2) on 2,786 native items from 2000-01-01 to 2027-09-25 found that its event properties add nothing that the ICS export does not have. Its UID is the `calendarItemIdentifier` of EventKit (the UID of the series for the 140 detached items). Its recurrence string writes the same rule again (it adds `INTERVAL=1` and changes `WKST`). Its sequence was the same as `SEQUENCE`. Its excluded dates covered 67 series, and `EXDATE` covered 127. Each property cost approximately 55 ms for each event, in a batch or not: 17 minutes for six properties of 3,337 events, against approximately 35 seconds for the ICS export ([ADR 0002](./docs/adr/0002-calendar-does-not-read-calendar-app-scripting.md)).

## Completeness and limits

Full-refresh overwrite and snapshot incremental both delete the rows of deleted events and of events that moved out of the window, on the next successful run. An incremental run writes only the rows that changed. An ordinary append keeps all observations.

The key of a child row is its position in content order, not in the order of EventKit ([ADR 0003](./docs/adr/0003-child-rows-are-numbered-in-content-order.md)). EventKit gives the attendees and alarms of an item, and its ICS export gives the sibling components of an item (the exceptions of a series and their alarms), in a different order in each process. A live check on **2026-09-25** (macOS 26.6.2) found that two runs some minutes apart, with no edits, wrote 2,600 attendee rows, 684 alarm rows and 1,294 ICS component rows again. The set of each event was the same, and only the order changed. The order of properties and parameters was stable. The source orders:

- attendees by URL, name, role and type, not by status, so a reply changes its row in place;
- alarms in firing order: relative alarms by offset, then absolute alarms by date, then by their other fields;
- ICS components by their content.

A new or changed child can renumber its siblings.

All selected streams come from one read with no store change in it: the helper reads again when the store changes during the read (see [read context](../../../elt/README.md#read-context)). Thus the relationships between streams agree. The destination commits each stream on its own. The helper streams its output with no size limit and no timeout. Duplicate tracking keeps the occurrence and child IDs during one copy.

The source keeps the EventKit fields above. These capabilities need more than one more field:

- **Change feed:** EventKit gives change notifications but no durable change cursor. Thus each incremental run reads all of the window.
- **Attachment bytes and travel time:** attachment files load only through the `attachments` fetcher, because exported references need the authorization of the provider. Travel time is not exported. Modern macOS does not give the deprecated open-file alarm URLs.
- **Resumable large exports:** these need more extraction and checkpoint support. A full refresh starts a failed copy again, and it keeps the last destination contents until the full replacement succeeds.

Apple documents [EventKit retrieval](https://developer.apple.com/documentation/eventkit/retrieving-events-and-reminders), [occurrence identity](https://developer.apple.com/documentation/eventkit/ekevent/occurrencedate) and the [limits of calendar item identity](https://developer.apple.com/documentation/eventkit/ekcalendaritem/calendaritemidentifier).

## Attachment files

`icsAttachments` reads attachment bytes only when the target asks for them, and remote references need a fetcher. For Google calendars, `googleCalendarAttachments` (`@workspace/source-apple-calendar/google-calendar-attachments`) downloads:

- Drive files: native Docs, Sheets and Slides as PDF, shortcuts followed to their target, and link-shared files with their resource key;
- Gmail message attachments.

It needs a `googleSession` from `google-auth` whose grant has `drive.readonly` and `gmail.readonly`, from an OAuth client whose project enables the Drive and Gmail APIs. It resolves false for other URLs and for files that the account cannot open, also for Google files that are too large to export as PDF (10 MB). A file that the account cannot open (HTTP 404, or a 403 that Drive or Gmail gives because the account may not open the file) loads with a `null` file. A rate limit, a disabled API, a missing scope or any other failure fails the copy, and the next run continues it. Connect the fetcher in this way:

```ts
const requester = await googleSession({
  clientId,
  clientSecret,
  scopes: [GOOGLE_DRIVE_READONLY_SCOPE, GMAIL_READONLY_SCOPE],
  directory: join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'elt',
  ),
});
const calendar = new AppleCalendarSource({
  store: new CalendarStore(
    fileURLToPath(
      import.meta.resolve('@workspace/sdk-apple-eventkit/eventkit-helper'),
    ),
  ),
  startAt,
  endAt,
  attachments: googleCalendarAttachments(requester),
});
new Copy(
  calendar.icsAttachments,
  sqlite.table('attachments', (c) => [
    c.text('uri'),
    c.text('filename'),
    c.blob('bytes').from(calendar.icsAttachments.file),
  ]),
);
```

## Coverage

The [coverage](../../../elt/README.md#coverage) of each stream of events is the configured window: the overlap interval `[startAt, endAt)`, also when no event is in it. A zero-duration event must start in it. The coverage of `accounts` and `calendars` is a list with no date filter: the window does not limit these lists. ICS can tell of a recurring series past the selected occurrences. `currentAsOf` is `null`.

## Limitations

- `startAt` and `endAt` are mandatory UTC timestamps. The source cannot read a range without an end, because a recurring series can have no end.
- EventKit has no change feed. Thus each run reads all of the range. An occurrence that is deleted, or that moves out of the range, is deleted from the destination on the next run.
- EventKit IDs can change after a full server sync. Child rows, such as attendees and alarms, have their position as their key. Thus a new or changed child can renumber the other children.
- The ICS streams use a private EventKit API. If a macOS version does not have it, the copy fails with `CalendarIcsUnavailableError`. If this is a problem, select only the other streams.
- Travel time is not exported.

## Live checks

### Calendar export probe

A read-only probe on macOS 26.6.2 (2026-09-21) examined the output of **File > Export** in Calendar:

- **`.ics`:** the sample kept raw recurrence rules, excluded dates, recurrence IDs, five attachment references, and Google and Microsoft conference properties. It had no embedded attachment bytes. Three references were HTTPS URLs, and two were relative query references that need the context of the provider.
- **`.icbu`:** the archive had `Calendar.sqlitedb` and `Info.plist`. Its five attachment records had no local file paths or embedded payloads. The database had travel-time columns, but each sampled value was null. Thus nobody verified that a travel time is kept.

The source does not use these GUI exports. The ICS streams read the same iCalendar data for each item through EventKit. The schema of the private database in the archive is not a stable public API. The personal probe exports were temporary, and they are not repository fixtures.

### ICS export verification

On **2026-09-24** (macOS 26.6.2, Asia/Amman), read-only probes exported each item in ±180 days (960 items) and printed only property names and counts:

- Both private selectors exist. No export was empty, and the largest item was 92 KB.
- The export of each detached item has its own `RECURRENCE-ID` with `TZID`. The export of a recurring master can also include its override `VEVENT`s.
- Vendor properties arrive complete: `X-GOOGLE-CONFERENCE` (33 events), `X-GOOGLE-CALENDAR-CONTENT-TITLE`, `X-MICROSOFT-CDO-*`, and `X-APPLE-STRUCTURED-LOCATION` with its parameters. No `ATTACH` occurred in that window. A second probe read all of the history (2005–2030 in windows of three years, 3,286 items) and found 4 items with 5 `ATTACH` properties from 2021–2023. A read of those days through `AppleCalendarSource` loaded all 5 as `icsProperties` rows with 13 `icsParameters` rows: 3 `FMTTYPE`, 5 `VALUE=URI` and 5 `X-APPLE-FILENAME`. Three values are HTTPS URLs, and two are relative references that need the context of the provider, as in the GUI export above. None had inline bytes.

On **2026-09-24**, `googleCalendarAttachments` downloaded them with one account (the account of the calendars) and a Desktop client of the project that enables Search Console, Drive and Gmail:

- Both Gmail references downloaded with the same bytes. A 102,262-byte PNG and a 115,390-byte PDF had the sizes and file signatures of the Gmail message parts. This shows that `attid=0.N…` maps to part `N…` of message `th`.
- The three Drive references gave 404 for the account. Its Drive, with the trash and shared drives, had no file with any of their names, so somebody deleted the files. They loaded as rows with a `null` file.
- Two processes exported the same items three seconds apart. Only `DTSTAMP` changed, for all 280 events, and the structure never changed. `DTSTAMP` is the export time, so the streams do not include it.

A live run then saved a temporary weekly event with a URL, a location and an alarm, and detached its second occurrence. It ran `events` and the three ICS streams incrementally into SQLite:

- The first run loaded all rows.
- The second run, with no changes, wrote nothing in any stream.
- After the deletion of the probe, the next run removed its three occurrences and all of its ICS rows. A new EventKit read showed that the events were gone.

That last run also wrote 48 component rows of other items again. Four later runs with no changes, 15 seconds apart, wrote nothing. Thus the cause is probably calendar activity at the same time, not the export. Nobody verified the cause.

## Decisions

- [ADR 0001](./docs/adr/0001-the-ics-streams-read-a-private-eventkit-export.md): the ICS streams read a private EventKit export.
- [ADR 0002](./docs/adr/0002-calendar-does-not-read-calendar-app-scripting.md): Calendar does not read the scripting interface of Calendar.app.
- [ADR 0003](./docs/adr/0003-child-rows-are-numbered-in-content-order.md): child rows are numbered in content order.
- [ADR 0004](./docs/adr/0004-a-moved-occurrence-is-keyed-by-its-series.md): a moved occurrence is keyed by its series.
