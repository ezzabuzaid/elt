# @workspace/source-apple-reminders

An ELT source for Apple Reminders. It reads reminder lists and reminders through EventKit, with the `eventkit-helper` process of `@workspace/sdk-apple-eventkit`. It does not use the network or the scripting API of Reminders, and Reminders does not have to be open.

```ts
import { fileURLToPath } from 'node:url';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { RemindersStore } from '@workspace/sdk-apple-eventkit';
import { AppleRemindersSource } from '@workspace/source-apple-reminders/apple-reminders-source';

const source = new AppleRemindersSource({
  store: new RemindersStore(
    fileURLToPath(
      import.meta.resolve('@workspace/sdk-apple-eventkit/eventkit-helper'),
    ),
  ),
});
const destination = new SQLiteDestination({
  path: './outputs/reminders.sqlite',
});

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'apple-reminders',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './outputs/reminders-state.sqlite',
      }),
      steps: (await source.discover()).streams.map(
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

The host decides where the compiled helper is. The example uses the helper that the SDK package builds.

## Streams

The source reads **EventKit only**, through the `eventkit` helper of `@workspace/sdk-apple-eventkit` ([ADR 0001](./docs/adr/0001-reminders-reads-eventkit-only.md)). The [Calendar README](../calendar/README.md) tells how the helper runs.

| Stream                 | Contents                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `accounts`             | EventKit sources: `id`, name, type, delegate flag. This can include accounts that have no visible reminder list.                                                                                                         |
| `lists`                | Reminder calendars: `id`, `accountId`, name, type, writable, subscribed and immutable flags, sRGB color components, availability and entity masks.                                                                       |
| `reminders`            | Each reminder, complete or not: `id`, `listId`, external identifier (nullable), name, body, location, URL, item time zone, creation, modification and completion timestamps (nullable), completion flag, priority (0–9). |
| `dateComponents`       | Up to two rows for each reminder, linked by `reminderId`, with `kind` `start` or `due`. Each row keeps the date components, the calendar identifier and the time zone (nullable) that EventKit stores.                   |
| `attendees`            | EventKit participants, when EventKit gives them: `reminderId`, position, name, URL, status, role, type, current-user flag. This is not the sharing or assignment API of Reminders.                                       |
| `alarms`               | `reminderId`, position, type, relative offset, absolute timestamp, email, sound, proximity, location title, latitude, longitude, radius in meters.                                                                       |
| `recurrenceRules`      | `reminderId`, position, calendar identifier, frequency, interval, first weekday, end date or count.                                                                                                                      |
| `recurrenceRuleValues` | `reminderId`, `ruleId`, component, position, value and weekday ordinal (optional). It keeps all six public recurrence selectors.                                                                                         |

All eight streams are [snapshot streams](../../../elt/README.md). Use full refresh, or `incremental` with `append_dedup` and no `cursorField`. They work with inferred SQLite tables.

## Dates and values

- Date components keep undefined values as `null`, also the missing clock components of a reminder without a time.
- A null time zone is a floating date and time. The source never replaces it with UTC.
- The start, due and item time zones stay separate. The source does not make a UTC due time from a reminder without a time or from a floating reminder.
- Timestamp properties stay UTC ISO strings.
- A reminder without a start or due property has no component row for it.
- On macOS 26.6.2, EventKit refused date components with a calendar that is not Gregorian (`Calendar must be nil or Gregorian`). EventKit also changed a due time that had only an hour and no calendar: the stored components had the Gregorian calendar and `minute: 0`. The source loads the components that EventKit stores, not the values that an app set.
- Enum values stay integers. Alarm proximity is `0` (none), `1` (arrival) or `2` (departure). A radius of `0` lets the system select the radius. Recurrence frequency is `0` (daily), `1` (weekly), `2` (monthly) or `3` (yearly). A recurrence count of zero sets no count limit.
- Apple gives only the next incomplete reminder of a recurring series. The source does not make future occurrences, and it does not send notifications.

## Identity and changes

- EventKit IDs can change after a full server sync. External identifiers are not unique or stable across providers and devices.
- A child ID identifies a position in the current snapshot. The source numbers attendees and alarms in content order, so a new or changed child can renumber the other children (see the [Calendar README](../calendar/README.md)).
- Full-refresh overwrite and snapshot incremental both delete the rows of reminders that disappeared. An incremental run also reads every reminder, because EventKit has no change feed.
- All selected streams come from one read with no store change in it: the helper reads again when the store changes during the read (see [read context](../../../elt/README.md)). The destination commits each stream on its own, and no transaction covers the pipeline.
- A run of only `accounts` and `lists` reads no reminders.
- The helper streams its output with no size limit and no process timeout.

## Access

The source needs macOS 27, because the helper is built for it. Give **full Reminders access** to the process that runs the pipeline, in **System Settings > Privacy & Security > Reminders**. Calendar access and Automation access do not replace it. Full Disk Access is not necessary. A sandbox can block access also when macOS gives the permission.

Construction, discovery and validation do no native read and ask for no permission. The first read asks for access if the user did not decide yet, and waits up to 30 seconds. If access is denied, restricted, pending or revoked, the read fails with `RemindersUnavailableError`, which keeps the error of the process as its `cause`.

A fetch waits up to 60 seconds, and then the helper cancels the request. A nil fetch result is an error. Only a successful empty array can clear a target. A failed read keeps the last contents of the target.

## Scope

`new AppleRemindersSource({ store, scope })` narrows the import. `accountIds` selects accounts, and `collectionIds` selects reminder lists. If you omit a key, the source reads all.

## Limitations

- EventKit has no change feed. Each run reads every reminder, and deletes the rows of reminders that disappeared.
- EventKit IDs can change after a full server sync. External identifiers are not unique or stable across providers and devices.
- Apple gives only the next incomplete reminder of a recurring series. The source does not make future occurrences.
- The source loads the date components that EventKit stores. These can differ from the values that an app set.
- A watch wakes on each change to the EventKit store, also on a Calendar change.

The [EventKit Reminders notes](../../../../docs/eventkit-reminders.md) give the API findings, the design and the verification.

## Decisions

- [ADR 0001](./docs/adr/0001-reminders-reads-eventkit-only.md): Reminders reads EventKit only.
