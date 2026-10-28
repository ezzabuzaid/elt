# @workspace/source-apple-notification-center

An ELT source for macOS Notification Center. It reads the store that usernoted keeps for Notification Center, `~/Library/Group Containers/group.com.apple.usernoted/db2/db`, in read-only mode through `@workspace/sdk-apple-notification-center`. It does not use the network or the UserNotifications framework, and no app has to be open.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { AppleNotificationCenterSource } from '@workspace/source-apple-notification-center/apple-notification-center-source';

const source = new AppleNotificationCenterSource();
const destination = new SQLiteDestination({
  path: './outputs/notifications.sqlite',
});
const pipeline = new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'apple-notification-center',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './outputs/notifications-state.sqlite',
      }),
      steps: [
        source.notifications,
        source.apps,
        source.categories,
        source.categoryActions,
      ].map(
        (stream) =>
          new Copy(stream, destination.table(stream.name), {
            id: stream.name,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
      ),
    }),
  ],
});

const controller = new AbortController();
for await (const pass of pipeline.watch({ signal: controller.signal })) {
  // Each pass loaded the notifications that arrived since the last one.
}
// Call controller.abort() to stop the watch.
```

Notification Center keeps many notifications for some minutes only. A watch checks the store every second and loads each notification before it goes. A pipeline that only calls `run()` gets what the store holds at each run.

## Streams

| Stream            | One record for each                                                      |
| ----------------- | ------------------------------------------------------------------------ |
| `notifications`   | notification that Notification Center delivered while the source read it |
| `apps`            | app that posted to Notification Center, with its badge now               |
| `categories`      | notification category that an app registered, in its order               |
| `categoryActions` | button that a category puts on its notifications, for example Reply      |

A notification has its title, subtitle, body, thread, category, delivery and expiry times, and the `userInfo` of the app. `payload` keeps all keys of the stored property list as JSON. The `id` is the UUID of the delivery.

## Access

Give **Full Disk Access** to the process that runs the pipeline. Without it, all streams fail with `NotificationCenterUnavailableError`, which names the grant. If the store does not have a column that the reader uses, all streams fail with `MissingColumnsError`. This error names the missing columns.

## Scope

`new AppleNotificationCenterSource(path, scope)` narrows the import. `startAt` (inclusive) and `endAt` (exclusive) select notifications by `deliveredAt`. `apps`, `categories` and `categoryActions` have no date and load whole.

## Limitations

- `notifications` does not delete rows. A notification that leaves the store keeps its row, so the rows are a history, not what Notification Center shows now. usernoted stores no reason for a removal.
- A notification that replaces an earlier one loads as a new row.
- `apps`, `categories` and `categoryActions` show the store now. A run deletes an uninstalled app and a category that its app does not register any more.
- The meaning of some codes is not known, for example `style`, `orig` and `dest`. They load as stored.

See [docs/reference.md](../../../../docs/reference.md#apple-notification-center) for the details.
