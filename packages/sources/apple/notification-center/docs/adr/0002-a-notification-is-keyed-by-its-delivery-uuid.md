# A notification is keyed by its delivery UUID

usernoted uses the `rec_id` of a deleted row again. Thus `rec_id` can name two different notifications at two times, and a key from it would join a new notification to the row of an old one. The UUID of the delivery (`record.uuid`) is unique, and the Biome stream `Notification.Usage` uses the same UUID.

Thus the `id` of a notification is the UUID of the delivery, in uppercase as `NSUUID` writes it. Categories have no unique identifier: an app can register the same identifier two times, as Wallet did on 2026-10-07. Thus a category is keyed by the app and its position in the list, and an action by the app, the position of its category and its own position.

## Considered Options

- **Key a notification by `rec_id`.** usernoted uses it again.
- **Key a notification by the delivery UUID.** This option was selected.

## Consequences

- A notification that replaces an earlier one loads as a new row next to the row that it replaced.
- A reader joins `notifications.id` with `notificationUsage.notificationId` of the Activity source.

Sources: commit ec286f9b.
