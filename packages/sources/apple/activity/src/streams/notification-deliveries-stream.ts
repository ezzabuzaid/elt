import type { RecordDraft } from '@workspace/elt';
import {
  NotificationDelivery,
  type NotificationDeliveryEvent,
} from '@workspace/sdk-apple-biome';

import { activityFields, isoTime } from '../activity-values.ts';
import {
  BiomeActivityStream,
  type BiomeAddress,
  biomeAddress,
} from '../biome-activity-stream.ts';

const properties = {
  ...biomeAddress,
  requestId: {
    ...activityFields.text,
    description: 'Identifier the app gave the notification request.',
  },
  bundleId: {
    ...activityFields.bundleId,
    description: 'Bundle identifier of the app that posted it.',
  },
  occurredAt: {
    ...activityFields.timestamp,
    description: 'When it was delivered; it can precede recordedAt by hours.',
  },
} as const;

export class NotificationDeliveriesStream extends BiomeActivityStream<
  typeof properties,
  NotificationDeliveryEvent
> {
  readonly name = 'notificationDeliveries';
  readonly biome = new NotificationDelivery();
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per notification delivered on this Mac (Biome Notification.Delivery). macOS keeps these for three days.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: NotificationDeliveryEvent,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      requestId: event.requestId,
      bundleId: event.bundleId,
      occurredAt: isoTime(event.occurredAt),
    };
  }
}
