# @workspace/source-apple-notification-center

An ELT source for macOS Notification Center. It reads `~/Library/Group Containers/group.com.apple.usernoted/db2/db`, the store that usernoted keeps for Notification Center, with the SDK `@workspace/sdk-apple-notification-center`. It does not use the network, Notification Center or the UserNotifications framework, and no app has to be open. The framework shows an app only its own notifications.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md), and the glossary of [elt](../../../elt/CONTEXT.md) for the words of all of elt.

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

Notification Center keeps many notifications for some minutes only. A watch examines the store every second and loads each notification before it goes. A pipeline that only calls `run()` gets what the store holds at each run. See [Watching](#watching).

`new AppleNotificationCenterSource(path, scope)` takes the path of the store and a scope: see [Date range](#date-range).

A Context Compiler import loads every stream incrementally into its `data.sqlite`. Readers use its `<snake_stream>` views (`notifications`, `apps`, `categories`, `category_actions`). Every stream of a run reads one snapshot of the store: a read transaction on a read-only connection. The connection is never `immutable`, because usernoted keeps a write-ahead log.

## Access

The store needs [Full Disk Access](../messages/README.md) for the process that runs the pipeline. On 2026-10-07, a terminal with the grant read the store. A launchd job without the grant got the SQLite error AUTH (23, `authorization denied`), and `Operation not permitted` when it listed `db2/`. The store of Mail gave the same errors in the same job. The source turns the error into `NotificationCenterUnavailableError`, which names the grant, and every stream fails.

## Streams

| Stream            | Upstream                                    | One record for each                                                             |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| `notifications`   | `record`, and its `data` property list      | notification that Notification Center delivered while the source read the store |
| `apps`            | `app`                                       | app that posted to Notification Center, with its badge now                      |
| `categories`      | `categories`, one list for each app         | notification category that an app registered, in the order that it gave them    |
| `categoryActions` | the same lists, the `acts` of each category | button that a category puts on its notifications, for example Reply             |

usernoted keeps each notification as a binary property list in `record.data`, with keys of four letters. The reader names the keys whose meaning the strings of usernoted or the public API of Apple fix:

- `titl`, `subt` and `body`: title, subtitle and body.
- `iden`: the identifier that the app gave the request.
- `thre`: the thread. `cate`: the category.
- `durl`: the default action URL. `soun.nam`: the sound.
- `edat`: when usernoted removes the notification.
- `intrp`: the `UNNotificationInterruptionLevel` (0 passive, 1 active, 2 time-sensitive, 3 critical).
- `unct`: the communication content type.
- `usda`: the `userInfo` of the app, an NSKeyedArchiver archive that names the record in the store of the app (a Messages message GUID, a Mail message ID, a Calendar event, a Codex `conversation_id`).

`payload` keeps every key as JSON, named or not. Nested archives are decoded in place, and data is Base64. This includes the communication context `uncc` (the handle of a Messages sender), and `orig`, `dest`, `srce`, `resp` and `trig`, whose codes Apple does not document. `style` is the code of usernoted from `record.style`: 0 or 1 on macOS 27.

The `id` of a notification is the UUID of the delivery (`record.uuid`) in uppercase, as `NSUUID` writes it ([ADR 0002](./docs/adr/0002-a-notification-is-keyed-by-its-delivery-uuid.md)). It is the `notificationUsage.notificationId` of [Activity](../activity/README.md). `requestId` is the `notificationDeliveries.requestId` of Activity: match it together with its bundle identifier, and ignore case. `notifications.bundleId` keeps the case of the app, and `apps.bundleId` is in lowercase, as usernoted keys it. Notifications that an app posted through the legacy API, for example the notifications of Script Editor, have no request identifier, thread or category. `deliveredAt` and `expiresAt` are [`date-time` with `precision` 6](../../../elt/README.md): usernoted keeps seconds since 2001-01-01 in a double with a microsecond fraction.

An app registers its categories as one full list. Their texts can be localized, stored as `[key, key, arguments]`. The reader loads the key, which the bundle of the app resolves. Categories are keyed by their position in the list: on 2026-10-07, Wallet registered `PDUserNotificationTypeAccountPaymentDue` two times, with different options.

The source does not read these: `delivered` and `displayed`, which list the notification UUIDs of each app and thus index `record`; `requests`, which was empty on this Mac and thus has no type (backlog item 2435); and `dbinfo`.

## Date range

The scope selects notifications by `deliveredAt`, from `startAt` (inclusive) to `endAt` (exclusive). `apps`, `categories` and `categoryActions` have no date and always load in full.

## Changes and deletions

`notifications` is a [forgetting upstream](../../../elt/README.md): it declares no `emitsDeletes` ([ADR 0001](./docs/adr/0001-a-notification-keeps-its-row-after-the-store-forgets-it.md)). A notification that leaves the store keeps its row. Thus the rows are a history, not what Notification Center shows now.

usernoted deletes the row of a notification in these cases: its app withdraws it, the user clears it, a newer notification with the same request identifier replaces it, it expires, the app clears its badge, a dismissal syncs from a different device, or the user uninstalls the app. Each time, it uses the same `DELETE` under `secure_delete`, and it keeps no record of the reason. Only the unified log, which macOS keeps for about two days, names the cause. From 2026-10-05 to 2026-10-07, apps withdrew most of them (cmux 105, Codex 27, Reminders 14, Teams 7). Thus a notification that the user cleared also stays in the destination. usernoted uses the `rec_id` of a deleted row again. Thus the key is the UUID of the delivery, and a replacement loads as a new row next to the row that it replaced.

`apps`, `categories` and `categoryActions` are [snapshot streams](../../../elt/README.md) with deletions, because they describe the store now. When the user uninstalls an app, the `app_deleted` trigger of usernoted removes the app and its records, and the source deletes its rows. A category that its app does not register any more is deleted too.

The SDK checks every column that it reads when a snapshot opens. If a macOS layout does not have one of them, every stream fails with `MissingColumnsError`, which names the missing columns, and the destination stays as it was.

## Watching

A watch polls the `data_version` of the store every second through `NotificationCenterStore.version()`. usernoted commits through its WAL on each delivery, withdrawal and badge. One database cannot tell which table a commit changed. Thus each commit wakes every selected stream, and the snapshot diff writes nothing for the streams that did not change.

Notification Center keeps many notifications for some minutes only. From 2026-10-06 07:00 to 2026-10-07 13:30, the Biome stream `Notification.Delivery` logged 168 deliveries (cmux 129, Bluetooth 22, Teams 12) that were not in the store at the next read. A watching pipeline loads each one in less than one second. A pipeline that only calls `run()` holds what Notification Center held at each pass.

## Live checks

Checked live on 2026-10-07 on macOS 27.0 (26A428), usernoted database version 19:

- The store held 59 to 64 notifications from 2026-10-06 07:14. usernoted made the file again on 2026-10-02, and `rec_id` started again at 1. It also held 141 apps (136 without a badge) and 42 category lists with 300 categories and 752 actions. `codec-plist` decoded every `data`, `usda` and `uncc` blob.
- A load through the Context Compiler CLI took 0.36 s. It wrote 63 notifications, 141 apps, 300 categories and 752 actions. A second load wrote nothing. A load one minute later wrote 2 new notifications and kept the 1 notification that usernoted dropped in that time (65 loaded, 64 in the store). It also loaded the categories that an app registered again (14 categories and 31 actions written, 8 deleted).
- Expiry: a temporary calendar had an event that ended one minute after its alert. Calendar posted a notification with `expiresAt` at the end of the event. At that time, usernoted logged `Request uuid: … from com.apple.iCal expired` and deleted the row. The next load deleted nothing and kept the notification. `requests` stayed empty, so a Calendar alarm does not go through it. The calendar was deleted after the check.
- A [shape change](../../../elt/README.md) keeps what the destination holds. On 2026-10-08, an import held a Calendar alert that usernoted had expired and deleted. After a field was added to `notifications`, a load emitted again the 81 notifications that the store held, deleted none, and kept the expired notification, with NULL in the new field.
- Two reads one minute apart, with no delivery between them, gave the same bytes for each blob. Thus no value changes from one read to the next.

Not verified:

- A dismissal synced from a different device. It needs the other device of the user and was not done. It is a `DELETE` like the others, with no stored reason, so the destination keeps the notification as it keeps every removal.
- The meaning of `style`, `orig`, `dest` and the action code `st`. Apple does not document them. The strings of usernoted list `none`, `banner` and `alert` for its notification style. But Calendar, whose alert style in `com.apple.ncprefs` is alerts, stored `style` 0, and apps set to banners stored 1. Thus the codes do not agree with the setting.
- `requests`, which was empty, also while a Calendar alarm fired.

## Limitations

- `notifications` does not delete rows. A notification that leaves the store keeps its row, so the rows are a history, not what Notification Center shows now. usernoted stores no reason for a removal.
- A notification that replaces an earlier one loads as a new row.
- `apps`, `categories` and `categoryActions` show the store now. A run deletes an uninstalled app and a category that its app does not register any more.
- The meaning of some codes is not known, for example `style`, `orig` and `dest`. They load as stored.

## Decisions

- [ADR 0001](./docs/adr/0001-a-notification-keeps-its-row-after-the-store-forgets-it.md): a notification keeps its row after the store forgets it.
- [ADR 0002](./docs/adr/0002-a-notification-is-keyed-by-its-delivery-uuid.md): a notification is keyed by its delivery UUID.

## Development

Run the commands from the workspace root.

```sh
npx nx run source-apple-notification-center:test        # builds, then runs src/*.test.ts
npx nx run source-apple-notification-center:typecheck   # formats, lints, then type checks
```
