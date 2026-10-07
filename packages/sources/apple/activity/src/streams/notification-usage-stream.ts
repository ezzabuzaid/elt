import type { RecordDraft } from '@workspace/elt';
import {
  NotificationUsage,
  type NotificationUsageEvent,
} from '@workspace/sdk-apple-biome';

import { activityFields, isoTime } from '../activity-values.ts';
import {
  BiomeActivityStream,
  type BiomeAddress,
  biomeAddress,
} from '../biome-activity-stream.ts';

const properties = {
  ...biomeAddress,
  notificationId: {
    ...activityFields.text,
    description: 'Identifier of the notification, a UUID.',
  },
  occurredAt: {
    ...activityFields.timestamp,
    description: 'When it happened, as the event states it.',
  },
  usageType: {
    ...activityFields.integer,
    description:
      'What happened to the notification, as stored (1, receipt, observed).',
  },
  bundleId: {
    ...activityFields.text,
    description:
      'Bundle identifier of the app that posted it, or a system section name.',
  },
} as const;

export class NotificationUsageStream extends BiomeActivityStream<
  typeof properties,
  NotificationUsageEvent
> {
  readonly name = 'notificationUsage';
  readonly biome = new NotificationUsage();
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per notification event on this Mac (Biome Notification.Usage): which app notified, and when. Biome keeps no title or body here.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: NotificationUsageEvent,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      notificationId: event.notificationId,
      occurredAt: isoTime(event.occurredAt),
      usageType: event.usageType ?? null,
      bundleId: event.bundleId,
    };
  }
}
