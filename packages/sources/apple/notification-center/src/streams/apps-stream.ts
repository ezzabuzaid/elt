import type { RecordDraft } from '@eltjs/elt';
import type { NotificationApp } from '@eltjs/sdk-apple-notification-center';

import {
  AppleNotificationCenterStream,
  notificationCenterFields,
} from '../apple-notification-center-stream.ts';
import type { NotificationCenterScan } from '../notification-center-scan.ts';

const { id, ordinal, nullableInteger } = notificationCenterFields;

const properties = {
  id: {
    ...ordinal,
    description:
      'The app’s row in usernoted’s store (app.app_id), the key the store declares; notifications.appId and categories.appId refer to it.',
  },
  bundleId: {
    ...id,
    description:
      'The app’s bundle identifier, lowercased as usernoted stores it (app.identifier); system senders carry a _system_center_: prefix. No index keeps it unique.',
  },
  badge: {
    ...nullableInteger,
    description:
      'The number on the app’s icon (app.badge); NULL when it shows none.',
  },
} as const;

export class AppsStream extends AppleNotificationCenterStream<
  typeof properties,
  NotificationApp
> {
  readonly name = 'apps';
  readonly primaryKey = ['id'];
  readonly emitsDeletes = true;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per app that has posted to Notification Center, with its badge now. Primary key id. An app macOS forgets, such as one uninstalled, is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: NotificationCenterScan): Iterable<NotificationApp> {
    return scan.snapshot.apps();
  }

  protected records(app: NotificationApp): RecordDraft<typeof properties>[] {
    return [{ id: app.id, bundleId: app.bundleId, badge: app.badge }];
  }
}
