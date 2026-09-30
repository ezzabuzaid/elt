# EventKit Reminders: research and implementation

Verified on macOS 26.6.2 on 2026-09-21. The connector supports macOS 27, the release the helper is built for. This document covers the public API needed to extract Reminders; creation, editing, deletion, UI presentation, and notification delivery are outside the export's scope.

## Decision and design

`AppleRemindersSource` uses EventKit exclusively, through `eventkit`, a compiled Swift helper. There are no calls to Reminders.app's scripting interface, no scripting fallback, and no matching between two identifier namespaces.

The design is the **Adapter pattern**, using the existing `Source` contract. `AppleRemindersSource` translates native objects into immutable stream descriptions and validated records consumed by `Copy`, `Pipeline`, SQLite, and Markdown. Calendar and Reminders reuse native projection and validation through composition:

- [eventkit/](../apps/apple/src/platform/macos/eventkit): the Swift helper. `eventkit read '<json request>'` checks access, fetches the reminders, and writes one JSON document per line (account, list, reminder); `eventkit watch reminders` prints `changed` per `EKEventStoreChangedNotification`. The Nx target `apple:eventkit` builds it as a universal (arm64 and x86_64) binary.
- [eventkit.ts](../apps/apple/src/platform/macos/eventkit.ts): the native `EventKit` class spawns the helper through [native-process.ts](../apps/apple/src/platform/macos/native-process.ts), parses its lines, maps its access failures to `RemindersUnavailableError`, and repeats reads that a store change disturbed. It does not import ELT or know about sources, streams, catalogs, or schemas. [eventkit-documents.ts](../apps/apple/src/platform/macos/eventkit-documents.ts) types the helper's documents.
- [eventkit-schema.ts](../apps/apple/src/sources/eventkit-schema.ts): connector-owned field schemas, catalog construction, and record validation.
- [eventkit-rows.ts](../apps/apple/src/sources/eventkit-rows.ts): rows shared with Calendar: accounts, lists, participants, alarms, and recurrence, with JSON-array IDs, ISO timestamps, content-order positions, and scope filtering.
- [reminder-rows.ts](../apps/apple/src/sources/apple-reminders/reminder-rows.ts): reminder and date-component rows.
- [apple-reminders-source.ts](../apps/apple/src/sources/apple-reminders/apple-reminders-source.ts): the source adapter composes `EventKit`, owns its catalog and identity, preflights selections, and validates records before yielding them to ELT.

All Apple connectors, native helpers, and the macOS parser belong to `apps/apple`. `packages/elt` contains only the platform-independent pipeline library. The dependency is one-way: the app imports the public `elt` API; neither the library nor the native client imports Apple source adapters.

Calendar keeps its own occurrence-window and occurrence-identity behavior.

## Public API findings

| Surface | Evidence and extraction choice |
| --- | --- |
| Permissions | Reminders access is separate from Calendar/Automation permissions. A sandbox can block access even when permission is granted. Permission checks occur during extraction. |
| Lists and accounts | `EKSource` exposes identifier, title, type and delegate status. `EKCalendar` exposes source, identifier, title, native type, writability, subscription/immutability, color and entity/availability masks. Query calendars with reminder entity type `1`. `store.sources` can include accounts without visible reminder lists. |
| Reminders | `EKReminder` adds start/due components, completion, completion date and priority to `EKCalendarItem`. The base class exposes identifiers, calendar, title, location, notes, URL, time zone, creation/modification dates, attendees, alarms and recurrence. Nullable dates remain nullable; a completed reminder may have no completion timestamp. |
| Fetching | `predicateForRemindersInCalendars(nil)` selects all available reminders, including completed items. `fetchRemindersMatchingPredicate:completion:` completes asynchronously. A nil completion result means failure. The returned request token supports cancellation. |
| Dates | Each start/due `NSDateComponents` is exported independently. Preserve partial/undefined components and its own calendar/time zone. Do not derive UTC instants or fill in missing components. Date-only and floating-time values therefore survive extraction without timezone shifts. |
| Alarms | `EKAlarm` exposes relative/absolute trigger, type, email/sound and structured location. `EKStructuredLocation` provides title, coordinates and radius; proximity determines entry or exit. macOS/iOS handles the actual notifications. |
| Recurrence | `EKRecurrenceRule` exposes frequency, interval, first weekday, calendar, end date/count, selected weekdays and their ordinals, month days, year days, year weeks, months and set positions. Store rules and selector values as related scalar rows. Apple exposes only the next incomplete recurring reminder, making unbounded future expansion inappropriate. |
| Identity | `calendarItemIdentifier` becomes `reminders.id`; calendar/source identifiers provide list/account relationships. Keep the external identifier separately. Local identifiers can change after full synchronization; external identifiers have duplicate and Exchange cross-device caveats. |
| Changes | `EKEventStoreChangedNotification` invalidates previously fetched data. It supplies neither a durable cursor nor deletion records, so incremental copies diff each full fetch with the previous snapshot instead. `Source.watch()` uses this notification only as a trigger to rerun copies; see [watching for changes](reference.md#watching-for-changes). |

The installed public headers inspected were `EKEventStore.h`, `EKReminder.h`, `EKCalendarItem.h`, `EKSource.h`, `EKCalendar.h`, `EKAlarm.h`, `EKStructuredLocation.h`, `EKRecurrenceRule.h`, `EKRecurrenceDayOfWeek.h`, `EKRecurrenceEnd.h`, `EKTypes.h`, and Foundation's `NSCalendar.h`.

No native tags, attachment export, flagged status, parent-reminder relationships, list groups or list emblems are exposed in those inspected public interfaces. Attendees do not establish support for the Reminders app's collaboration/assignment UI. Derived `hasNotes`/`hasAlarms`/`hasAttendees`/`hasRecurrenceRules` flags need no duplicate columns because the exported fields/relations contain that information. Deprecated UUIDs and in-memory edit state are not exported.

## Native helper and failure behavior

When access is undecided or write-only it asks for full access through `osascript`, because macOS answers a command-line helper's own request with "not granted" and shows no prompt; the grant goes to the terminal or app running the export, which the helper inherits. It waits at most 30 seconds for the answer. Without full access it writes `REMINDERS_UNAVAILABLE` to stderr and exits 1, which Node raises as `RemindersUnavailableError`; it checks again after the read, so access revoked mid-read fails too. `fetchRemindersMatchingPredicate:completion:` waits at most 60 seconds and cancels on timeout; a nil result fails the read. Invalid output, permission denial, and timeouts cannot become successful empty exports. The surrounding destination transaction/staging preserves the prior target on a failed copy.

`NSDateComponentUndefined` maps to null. No date normalization is done by the connector. A probe also found that mutating the same unsaved reminder from a floating due date to a zoned due date can retain a nil time zone; extraction preserves what EventKit returns.

All eight streams are flat scalar schemas. Date-component rows use `[reminderId, kind]`; alarm/attendee/rule rows use their parent's ID and position. These are snapshot identities: attendees and alarms are numbered in content order, and adding or editing one can renumber its siblings. One helper process reads every selected stream, and the read repeats when a store change arrives during it (see [EventKit consistency](reference.md#eventkit-consistency)), so relationships between streams agree. The helper streams its output with no size cap and no process timeout; a failed export restarts its copy.

## Verification

The focused tests in [index.test.ts](../apps/apple/src/index.test.ts) replace the helper at `nativeProcess.lines` with synthetic documents and exercise all eight streams through SQLite and Markdown, date-only/timed/floating/absent dates, completed reminders with no completion date, coordinates, both alarm forms, all recurrence selector families, metadata-only discovery, unsupported selections, and validation/permission rollback. Two tests run the real helper: one confirms a watch subscription and its shutdown, and one reads this Mac's reminders read-only into a temporary SQLite database, skipped without access. Tests never modify personal reminders.

A separate read-only live run fetched 69 reminders, 52 date-component rows and 34 alarms into a disposable SQLite database. It also exported 13 EventKit sources and one reminder list, with no orphan reminder or child relationships. This sample had no attendee or recurrence rows; those are covered by synthetic native fixtures. The temporary export was removed automatically. Sandboxed permission requests stayed undetermined; the same process outside the sandbox had full access and fetched successfully. The OS permission-prompt UI and execution on older supported macOS versions were not verified.

Verification targets are `nx run elt:typecheck`, `nx run elt:test`, `nx run apple:typecheck`, and `nx run apple:test`. The generic pipeline test lives in the ELT package; Apple connector and native fixture tests live in the app.

## Apple references

- [Accessing the event store](https://developer.apple.com/documentation/eventkit/accessing-the-event-store)
- [Request full Reminders access](https://developer.apple.com/documentation/eventkit/ekeventstore/requestfullaccesstoreminders(completion:))
- [Retrieving events and reminders](https://developer.apple.com/documentation/eventkit/retrieving-events-and-reminders)
- [Asynchronous reminder fetch](https://developer.apple.com/documentation/eventkit/ekeventstore/fetchreminders(matching:completion:))
- [Due date components](https://developer.apple.com/documentation/eventkit/ekreminder/duedatecomponents)
- [Recurring reminders](https://developer.apple.com/documentation/eventkit/creating-a-recurring-event)
- [Alarm location](https://developer.apple.com/documentation/eventkit/ekalarm/structuredlocation)
- [Calendar item identifiers](https://developer.apple.com/documentation/eventkit/ekcalendaritem/calendaritemidentifier)
- [External identifier caveats](https://developer.apple.com/documentation/eventkit/ekcalendaritem/calendaritemexternalidentifier)
- [Change notifications](https://developer.apple.com/documentation/eventkit/updating-with-notifications)
