import type { RecordDraft } from '@workspace/elt';
import type { NotificationApp } from '@workspace/sdk-apple-notification-center';

import {
  AppleNotificationCenterStream,
  notificationCenterFields,
} from '../apple-notification-center-stream.ts';
import type { NotificationCenterScan } from '../notification-center-scan.ts';

const { id, nullableInteger } = notificationCenterFields;

const properties = {
  bundleId: {
    ...id,
    description:
      'The app’s bundle identifier, lowercased as usernoted keys it (app.identifier); system senders carry a _system_center_: prefix.',
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
  readonly primaryKey = ['bundleId'];
  readonly emitsDeletes = true;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per app that has posted to Notification Center, with its badge now. Primary key bundleId. An app macOS forgets, such as one uninstalled, is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: NotificationCenterScan): readonly NotificationApp[] {
    return scan.apps;
  }

  protected records(app: NotificationApp): RecordDraft<typeof properties>[] {
    return [{ bundleId: app.bundleId, badge: app.badge }];
  }
}
