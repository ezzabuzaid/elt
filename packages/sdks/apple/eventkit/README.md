# @workspace/sdk-apple-eventkit

Reads Calendar and Reminders through EventKit, for the Calendar and Reminders sources of elt. A Swift helper, `eventkit`, does each read and each watch in its own process. `CalendarStore` and `RemindersStore` start the helper and read its output. The Calendar and Reminders sources are in `packages/sources/apple/calendar` and `packages/sources/apple/reminders`.

## Consistent reads

EventKit has no read transaction. Thus the Calendar and Reminders sources read with an optimistic method. See [read context](../../../elt/README.md#read-context) in elt.

- Each attempt is one process of the `eventkit` helper (`eventkit read`) that reads each selected stream.
- The process subscribes to `EKEventStoreChangedNotification` before it reads.
- EventKit posts the notification on the main run loop up to 250 ms after a change, and the read blocks that loop while it fetches. Thus the process runs the loop for 250 ms after it reads.
- When a change came, the process fails with `EVENTKIT_CHANGED`, and the store reads again.
- Five attempts in a row with a change raise `EventKitChangingError`.
- The snapshot holds the records of the selected streams in memory for the run.
- Measured on 2026-09-29 (macOS 27): a full Calendar read from 2000 to 2027 (10,956 events, about 110,000 rows of ICS parameters) took about 6 s, and a Reminders read about 0.1 s.

## Watch

`checks(signal)` of a store watches EventKit for the sources. A persistent helper process (`eventkit watch events|reminders`) subscribes to the native `EKEventStoreChangedNotification`.

- The helper writes `changed` for each change of the store. Its first line confirms the subscription.
- `checks(signal)` yields `changed` when the helper confirms its subscription and at each change, and `unchanged` for each quiet second between them. EventKit posts each change while the helper subscribes, so a quiet second is a check that found the store unchanged.
- A consumer that stops reading stops the helper, as an abort does.
- A change notice marks all selected streams as changed, because EventKit does not identify each change.
- The notice covers the full event store. Thus a Calendar edit also makes a Reminders watch extract again, and a Reminders edit also makes a Calendar watch extract again.
- The EventKit permissions that a read needs also apply to a watch.
- A full refresh with overwrite reconciles deletions at the next pass that succeeds.

## Live checks

On 2026-09-22, with macOS 26.6.2 and Node.js 26.8.1, the Calendar and Reminders sources ran through `Pipeline.watch()`, `Copy` and temporary SQLite destinations, with no mock of the notices or the extraction. Calendar and Reminders each completed four observed passes: the first pass, a create, an update and a delete. The changes were real EventKit writes from separate OSA processes. The SQLite assertions ran after the watch yielded the completed loads.

| Source stream         | Live assertions                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calendar `events`     | An event with a unique label appeared. Its changed title and start time got to SQLite. Its delete removed the exported row. The fixed window of occurrences was `2026-09-22T00:00:00.000Z` to `2026-09-23T00:00:00.000Z`. |
| Reminders `reminders` | A reminder with a unique label appeared. Its changed title and completed status got to SQLite. Its delete removed the exported row.                                                                                       |

- The watchers were closed after the check. The test event of Calendar, the temporary list of Reminders and the temporary databases were removed. New native reads confirmed the EventKit cleanup. No existing record of the user changed.
- This check covered the primary streams and SQLite. Edits in the apps of Calendar and Reminders, and the other streams, were not checked live.
- The tests cover the watch subscription of the helper and its stop on abort.

## Development

```sh
npx nx run sdk-apple-eventkit:test     # builds the helper and the package, then runs the tests
npx nx run sdk-apple-eventkit:helper   # builds dist/eventkit-helper from src/helper
```
