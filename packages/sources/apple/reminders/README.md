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

| Stream                 | Contents                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `accounts`             | EventKit sources: `id`, name, type, delegate flag.                                                        |
| `lists`                | Reminder lists: `id`, `accountId`, name, type, flags and color.                                           |
| `reminders`            | Each reminder, complete or not: `id`, `listId`, name, body, location, URL, time zone, times and priority. |
| `dateComponents`       | The `start` and `due` date components of each reminder, with calendar and time zone.                      |
| `attendees`            | EventKit participants of a reminder, when EventKit gives them.                                            |
| `alarms`               | The alarms of each reminder: offset, time, sound, proximity and location.                                 |
| `recurrenceRules`      | The recurrence rules of each reminder.                                                                    |
| `recurrenceRuleValues` | The values of each recurrence rule.                                                                       |

All streams are snapshot streams. Use full refresh, or `incremental` with `append_dedup` and no `cursorField`.

## Access

The source needs macOS 27. Give **full Reminders access** to the process that runs the pipeline, in **System Settings > Privacy & Security > Reminders**. Calendar access and Automation access do not replace it. Full Disk Access is not necessary.

The first read asks for access if the user did not decide yet, and waits up to 30 seconds. If access is denied, restricted, pending or revoked, the read fails with `RemindersUnavailableError`.

## Scope

`new AppleRemindersSource({ store, scope })` narrows the import. `accountIds` selects accounts, and `collectionIds` selects reminder lists. If you omit a key, the source reads all.

## Limitations

- EventKit has no change feed. Each run reads every reminder, and deletes the rows of reminders that disappeared.
- EventKit IDs can change after a full server sync. External identifiers are not unique or stable across providers and devices.
- Apple gives only the next incomplete reminder of a recurring series. The source does not make future occurrences.
- The source loads the date components that EventKit stores. These can differ from the values that an app set.
- A watch wakes on each change to the EventKit store, also on a Calendar change.

See [docs/reference.md](../../../../docs/reference.md#apple-reminders) for the details.
