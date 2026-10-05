import type { RecordDraft } from '@workspace/elt';
import type { ProtobufMessage } from '@workspace/source-apple-macos/protobuf';

import { activityFields, unixTime } from '../activity-values.ts';
import {
  type BiomeAddress,
  BiomeStream,
  biomeAddress,
} from '../biome-stream.ts';

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

export class NotificationDeliveriesStream extends BiomeStream<
  typeof properties
> {
  readonly name = 'notificationDeliveries';
  readonly biomeName = 'Notification.Delivery';
  readonly retentionDays = 3;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per notification delivered on this Mac (Biome Notification.Delivery). macOS keeps these for three days.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    payload: ProtobufMessage,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      requestId: payload.string(1),
      bundleId: payload.string(2),
      occurredAt: unixTime(payload.double(3)),
    };
  }
}
