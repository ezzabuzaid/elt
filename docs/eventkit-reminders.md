# EventKit Reminders: research and implementation

Verified on macOS 26.6.2 on 2026-09-21. The connector supports macOS 14 and later. This document covers the public API needed to extract Reminders; creation, editing, deletion, UI presentation, and notification delivery are outside the export's scope.

## Decision and design

`AppleRemindersSource` uses EventKit exclusively. JXA's Objective-C bridge runs through the existing `osascript` transport; there are no calls to `Application('Reminders')`, no scripting fallback, and no matching between two identifier namespaces.

The design is the **Adapter pattern**, using the existing `Source` contract. `AppleRemindersSource` translates native objects into immutable stream descriptions and validated records consumed by `Copy`, `Pipeline`, SQLite, and Markdown. Calendar and Reminders reuse native projection and validation through composition:

- [eventkit.ts](../apps/apple/src/platform/macos/eventkit.ts): the native `EventKit` class owns framework setup, permission checks, OSA execution, JSON decoding, and native error handling. It does not import ELT or know about sources, streams, catalogs, or schemas.
- [eventkit-schema.ts](../apps/apple/src/sources/eventkit-schema.ts): connector-owned field schemas, catalog construction, and record validation.
- [eventkit-script.ts](../apps/apple/src/sources/eventkit-script.ts): connector-owned native value conversion and scalar row projection for account/calendar metadata, participants, alarms, and recurrence.
- [reminders-script.ts](../apps/apple/src/sources/apple-reminders/reminders-script.ts): asynchronous fetch and Reminders/date-component projection.
- [apple-reminders-source.ts](../apps/apple/src/sources/apple-reminders/apple-reminders-source.ts): the source adapter composes `EventKit`, owns its catalog and identity, preflights selections, and validates records before yielding them to ELT.

All Apple connectors, native helpers, and the macOS parser belong to `apps/apple`. `packages/elt` contains only the platform-independent pipeline library. The dependency is one-way: the app imports the public `elt` API; neither the library nor the native client imports Apple source adapters.

The shared code was extracted from the working Calendar implementation and checked against its existing tests before replacing Reminders. Calendar retains its own occurrence-window and occurrence-identity behavior. The Reminders backend and schema change is an intentional migration, separate from that behavior-preserving extraction.

## Public API findings

| Surface | Evidence and extraction choice |
| --- | --- |
| Permissions | `requestFullAccessToRemindersWithCompletion:` is available from macOS 14. Reminders access is separate from Calendar/Automation permissions. The host must provide its usage description and required entitlements. Permission checks occur during extraction. |
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

## Native bridge and failure behavior

The Objective-C bridge can create/read unsaved reminders, dates, recurrence rules and geofenced alarms. Its exported symbols are not a complete SDK inventory: the new authorization constants and `CLLocation` class are missing from the inspected bridge exports. The permission gate uses the documented numeric statuses; native tests obtain `CLLocation` using public `NSClassFromString`. Coordinates on fetched location objects are readable normally.

An initial permission request waits at most 30 seconds. Extraction requires full access and checks again after projection. Reminder fetching pumps the run loop, waits at most 60 seconds and cancels on timeout. Invalid/nil output, permission denial, and timeouts cannot become successful empty exports. The surrounding destination transaction/staging preserves the prior target on a failed copy.

`NSDateComponentUndefined` maps to null. New Foundation selectors are checked before use: `dayOfYear` requires macOS 15 and `isRepeatedDay` requires macOS 26. Other platforms return null for those unavailable properties. No date normalization is done by the connector. A probe also found that mutating the same unsaved reminder from a floating due date to a zoned due date can retain a nil time zone; extraction preserves what EventKit returns, and date tests construct independent reminders.

All eight streams are flat scalar schemas. Date-component rows use `[reminderId, kind]`; alarm/attendee/rule rows use their parent's ID and position. These are snapshot identities, and collection reordering can change a child's ID. The source fetches each stream separately, so concurrent user edits can change relationships between copies. There is no cross-stream transaction or snapshot. OSA buffers one response up to 64 MiB and terminates after 120 seconds; a failed large export restarts its copy.

## Verification

The focused tests in [index.test.ts](../apps/apple/src/index.test.ts) exercise all eight streams through SQLite and Markdown, date-only/timed/floating/absent dates, completed reminders with no completion date, native coordinates, both alarm forms, all recurrence selector families, metadata-only discovery, unsupported selections, validation/permission rollback, nil versus empty fetches, cancellation, and the shared permission gate. Native fixtures are unsaved objects; tests never fetch personal reminders.

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
