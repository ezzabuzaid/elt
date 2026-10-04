# EventKit Reminders: research and implementation

Verified on macOS 26.6.2 on 2026-09-21. The connector supports macOS 27, the release the helper is built for. This document covers the public API needed to extract Reminders; creation, editing, deletion, UI presentation, and notification delivery are outside the export's scope.

## Decision and design

`AppleRemindersSource` uses EventKit exclusively, through `eventkit`, a compiled Swift helper. There are no calls to Reminders.app's scripting interface, no scripting fallback, and no matching between two identifier namespaces.

The design is the **Adapter pattern**, using the existing `Source` contract. `AppleRemindersSource` translates native objects into immutable stream descriptions and validated records consumed by `Copy`, `Pipeline`, SQLite, and Markdown. EventKit access is its own package, `packages/macos/eventkit` (`@workspace/macos-eventkit`), which does not import ELT or know about sources, streams, catalogs, or schemas; each source maps it into its own streams:

- [helper/](../packages/macos/eventkit/src/helper): the Swift helper. `eventkit read '<json request>'` checks access, fetches the reminders, and writes one JSON document per line (account, list, reminder); `eventkit watch reminders` prints `changed` per `EKEventStoreChangedNotification`. The Nx target `macos-eventkit:helper` builds it as a universal (arm64 and x86_64) binary.
- [eventkit-store.ts](../packages/macos/eventkit/src/eventkit-store.ts): `EventKitStore`, a template method base. It runs the helper through [native-process.ts](../packages/macos/eventkit/src/native-process.ts), repeats reads that a store change disturbed, keeps the accounts and lists inside the requested scope, orders each item's attendees and alarms by content, and maps access failures to the store's error. [reminders-store.ts](../packages/macos/eventkit/src/reminders-store.ts) is `RemindersStore`, whose `read()` returns accounts, lists (EventKit calendars) and reminders and throws `RemindersUnavailableError`. [documents.ts](../packages/macos/eventkit/src/documents.ts) types the helper's documents.
- [reminder-fields.ts](../packages/sources/apple/reminders/src/reminder-fields.ts) and [reminders-catalog.ts](../packages/sources/apple/reminders/src/reminders-catalog.ts): the Reminders field schemas and catalog. Calendar keeps its own copies of the account, list, participant, alarm and recurrence fields.
- [reminder-rows.ts](../packages/sources/apple/reminders/src/reminder-rows.ts): every Reminders row: accounts, lists, reminders, date components, attendees, alarms, and recurrence, with JSON-array IDs and ISO timestamps.
- [apple-reminders-source.ts](../packages/sources/apple/reminders/src/apple-reminders-source.ts): the source adapter composes `RemindersStore`, owns its catalog and identity, preflights selections, and validates records before yielding them to ELT.

The dependency is one-way: sources import `@workspace/macos-eventkit` and the public `elt` API; neither imports a source.

Calendar keeps its own occurrence-window and occurrence-identity behavior.

## Public API findings

| Surface            | Evidence and extraction choice                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permissions        | Reminders access is separate from Calendar/Automation permissions. A sandbox can block access even when permission is granted. Permission checks occur during extraction.                                                                                                                                                                                       |
| Lists and accounts | `EKSource` exposes identifier, title, type and delegate status. `EKCalendar` exposes source, identifier, title, native type, writability, subscription/immutability, color and entity/availability masks. Query calendars with reminder entity type `1`. `store.sources` can include accounts without visible reminder lists.                                   |
| Reminders          | `EKReminder` adds start/due components, completion, completion date and priority to `EKCalendarItem`. The base class exposes identifiers, calendar, title, location, notes, URL, time zone, creation/modification dates, attendees, alarms and recurrence. Nullable dates remain nullable; a completed reminder may have no completion timestamp.               |
| Fetching           | `predicateForRemindersInCalendars(nil)` selects all available reminders, including completed items. `fetchRemindersMatchingPredicate:completion:` completes asynchronously. A nil completion result means failure. The returned request token supports cancellation.                                                                                            |
| Dates              | Each start/due `NSDateComponents` is exported independently. Preserve partial/undefined components and its own calendar/time zone. Do not derive UTC instants or fill in missing components. Date-only and floating-time values therefore survive extraction without timezone shifts.                                                                           |
| Alarms             | `EKAlarm` exposes relative/absolute trigger, type, email/sound and structured location. `EKStructuredLocation` provides title, coordinates and radius; proximity determines entry or exit. macOS/iOS handles the actual notifications.                                                                                                                          |
| Recurrence         | `EKRecurrenceRule` exposes frequency, interval, first weekday, calendar, end date/count, selected weekdays and their ordinals, month days, year days, year weeks, months and set positions. Store rules and selector values as related scalar rows. Apple exposes only the next incomplete recurring reminder, making unbounded future expansion inappropriate. |
| Identity           | `calendarItemIdentifier` becomes `reminders.id`; calendar/source identifiers provide list/account relationships. Keep the external identifier separately. Local identifiers can change after full synchronization; external identifiers have duplicate and Exchange cross-device caveats.                                                                       |
| Changes            | `EKEventStoreChangedNotification` invalidates previously fetched data. It supplies neither a durable cursor nor deletion records, so incremental copies diff each full fetch with the previous snapshot instead. `Source.watch()` uses this notification only as a trigger to rerun copies; see [watching for changes](reference.md#watching-for-changes).      |

The installed public headers inspected were `EKEventStore.h`, `EKReminder.h`, `EKCalendarItem.h`, `EKSource.h`, `EKCalendar.h`, `EKAlarm.h`, `EKStructuredLocation.h`, `EKRecurrenceRule.h`, `EKRecurrenceDayOfWeek.h`, `EKRecurrenceEnd.h`, `EKTypes.h`, and Foundation's `NSCalendar.h`.

No native tags, attachment export, flagged status, parent-reminder relationships, list groups or list emblems are exposed in those inspected public interfaces. Attendees do not establish support for the Reminders app's collaboration/assignment UI. Derived `hasNotes`/`hasAlarms`/`hasAttendees`/`hasRecurrenceRules` flags need no duplicate columns because the exported fields/relations contain that information. Deprecated UUIDs and in-memory edit state are not exported.

## Native helper and failure behavior

When access is undecided or write-only it asks for full access through `osascript`, because macOS answers a command-line helper's own request with "not granted" and shows no prompt; the grant goes to the terminal or app running the export, which the helper inherits. It waits at most 30 seconds for the answer. Without full access it writes `REMINDERS_UNAVAILABLE` to stderr and exits 1, which Node raises as `RemindersUnavailableError`; it checks again after the read, so access revoked mid-read fails too. `fetchRemindersMatchingPredicate:completion:` waits at most 60 seconds and cancels on timeout; a nil result fails the read. Invalid output, permission denial, and timeouts cannot become successful empty exports. The surrounding destination transaction/staging preserves the prior target on a failed copy.

`NSDateComponentUndefined` maps to null. No date normalization is done by the connector. A probe also found that mutating the same unsaved reminder from a floating due date to a zoned due date can retain a nil time zone; extraction preserves what EventKit returns.

All eight streams are flat scalar schemas. Date-component rows use `[reminderId, kind]`; alarm/attendee/rule rows use their parent's ID and position. These are snapshot identities: attendees and alarms are numbered in content order, and adding or editing one can renumber its siblings. One helper process reads every selected stream, and the read repeats when a store change arrives during it (see [EventKit consistency](reference.md#eventkit-consistency)), so relationships between streams agree. The helper streams its output with no size cap and no process timeout; a failed export restarts its copy.

## Verification

The tests in [reminders-source.test.ts](../packages/sources/apple/reminders/src/reminders-source.test.ts) create a temporary reminders list through EventKit (JXA), in the first account that accepts one, read it through the real helper and source into SQLite and Markdown, and delete it: dated, undated, timed and floating reminders, completed reminders, alarms, recurrence rules, incremental changes and the documented views. What EventKit cannot produce runs through `StubEventKitHelper`, a real executable in place of the helper: attendees, a leap-month start, a due date without a calendar (EventKit fills in `gregorian`), malformed documents and denied access. A watch test confirms the subscription and its shutdown through the real helper, and one test reads this Mac's reminders read-only into a temporary SQLite database, skipped without access. The store's own behavior (retries, scope, content order, access errors) is tested in `packages/macos/eventkit`.

A separate read-only live run fetched 69 reminders, 52 date-component rows and 34 alarms into a disposable SQLite database. It also exported 13 EventKit sources and one reminder list, with no orphan reminder or child relationships. This sample had no attendee or recurrence rows; those are covered by synthetic native fixtures. The temporary export was removed automatically. Sandboxed permission requests stayed undetermined; the same process outside the sandbox had full access and fetched successfully. The OS permission-prompt UI and execution on older supported macOS versions were not verified.

Verification targets are `nx run elt:typecheck`, `nx run elt:test`, `nx run source-apple-reminders:typecheck`, and `nx run source-apple-reminders:test`. The generic pipeline test lives in the ELT package; the Reminders tests and their native fixtures live in the Reminders source package, and the tests that read Calendar and Reminders together live with the connectors in `apps/apple/connectors`.

## Apple references

- [Accessing the event store](https://developer.apple.com/documentation/eventkit/accessing-the-event-store)
- [Request full Reminders access](<https://developer.apple.com/documentation/eventkit/ekeventstore/requestfullaccesstoreminders(completion:)>)
- [Retrieving events and reminders](https://developer.apple.com/documentation/eventkit/retrieving-events-and-reminders)
- [Asynchronous reminder fetch](<https://developer.apple.com/documentation/eventkit/ekeventstore/fetchreminders(matching:completion:)>)
- [Due date components](https://developer.apple.com/documentation/eventkit/ekreminder/duedatecomponents)
- [Recurring reminders](https://developer.apple.com/documentation/eventkit/creating-a-recurring-event)
- [Alarm location](https://developer.apple.com/documentation/eventkit/ekalarm/structuredlocation)
- [Calendar item identifiers](https://developer.apple.com/documentation/eventkit/ekcalendaritem/calendaritemidentifier)
- [External identifier caveats](https://developer.apple.com/documentation/eventkit/ekcalendaritem/calendaritemexternalidentifier)
- [Change notifications](https://developer.apple.com/documentation/eventkit/updating-with-notifications)
