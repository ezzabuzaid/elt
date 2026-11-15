# A notification is keyed by its row and its delivery UUID

The key of a stream is an identity that its upstream enforces ([elt ADR 0022](../../../../../elt/docs/adr/0022-a-stream-s-key-is-an-identity-its-upstream-enforces.md)). The `record` table of usernoted declares `rec_id INTEGER PRIMARY KEY`, and no index keeps `uuid` unique. A key from the UUID alone fails a read with `twice in one scan` when two rows hold one UUID.

`rec_id` is unique in one scan, but not over time. The table is not `AUTOINCREMENT`, so SQLite gives a new row one more than the largest `rec_id` in the table. When usernoted deletes the newest row, the next notification gets its `rec_id` again. `notifications` keeps the rows that the store forgets ([ADR 0001](./0001-a-notification-keeps-its-row-after-the-store-forgets-it.md)). A key from `rec_id` alone would load the later notification over the row of the earlier one.

Thus a notification is keyed by `id` (`rec_id`) and `uuid` (the delivery UUID, in uppercase as `NSUUID` writes it). `rec_id` makes the key unique in a scan, and the UUID tells a later notification under a reused `rec_id` from the earlier one.

`app.app_id` and `categories.app_id` are the declared keys of the apps and of their category lists. `apps` is keyed by `id` (`app_id`). `app.identifier`, which no index keeps unique, is the column `bundleId`. A category is keyed by `appId` and its position in the list, and an action by `appId`, the position of its category and its own position: an app can register one category identifier two times, as Wallet did on 2026-10-07.

## Considered Options

- **Key a notification by the delivery UUID.** The store does not enforce it, so a repeated UUID fails the read.
- **Key a notification by `rec_id`.** usernoted uses it again, and a later notification loads over an earlier one that the destination keeps.
- **Key a notification by `rec_id` and the delivery UUID.** This option was selected.

## Consequences

- A notification that replaces an earlier one loads as a new row next to the row that it replaced, also when it gets the same `rec_id`.
- Two rows with one UUID load as two notifications.
- A reader joins `notifications.uuid` with `notificationUsage.notificationId` of the Activity source, and `notifications.appId`, `categories.appId` and `categoryActions.appId` with `apps.id`.
- `apps.id` names the row of an app while the app is in the store. A notification of an uninstalled app keeps its `appId` and its `bundleId`.

Sources: commit ec286f9b, elt ADR 0022, backlog item 4406.
