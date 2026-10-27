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

The Nx target `sdk-apple-eventkit:helper` builds the helper.

| Stream                                            | Contents                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `accounts`                                        | EventKit sources                                                             |
| `calendars`                                       | calendars, with their account, description, flags and color                  |
| `events`                                          | event occurrences that overlap the range `[startAt, endAt)`                  |
| `attendees`, `alarms`                             | the attendees and organizer, and the alarms, of each event                   |
| `recurrenceRules`, `recurrenceRuleValues`         | the recurrence rules of each event and their values                          |
| `icsComponents`, `icsProperties`, `icsParameters` | the iCalendar export of each event, as components, properties and parameters |
| `icsAttachments`                                  | one row for each `ATTACH` property; it supports file transfer                |

To narrow the import, give `scope` with `accountIds` or `collectionIds` (calendar IDs). To download remote attachment files, give `attachments`. `googleCalendarAttachments` (`@workspace/source-apple-calendar/google-calendar-attachments`) downloads Google Drive files and Gmail attachments.

Access: the source needs macOS 27 and full Calendar access for the app that runs the pipeline, such as the terminal. The first read asks for access if necessary. If access is denied, restricted or not decided, the read fails with `CalendarUnavailableError`. A sandbox can block access also when macOS gives the permission.

Limitations:

- `startAt` and `endAt` are mandatory UTC timestamps. The source cannot read a range without an end, because a recurring series can have no end.
- EventKit has no change feed. Thus each run reads all of the range. An occurrence that is deleted, or that moves out of the range, is deleted from the destination on the next run.
- EventKit IDs can change after a full server sync. Child rows, such as attendees and alarms, have their position as their key. Thus a new or changed child can renumber the other children.
- The ICS streams use a private EventKit API. If a macOS version does not have it, the copy fails with `CalendarIcsUnavailableError`. If this is a problem, select only the other streams.
- Travel time is not exported.

See [docs/reference.md](../../../../docs/reference.md#apple-calendar).
