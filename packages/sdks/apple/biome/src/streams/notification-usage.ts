import type { ProtobufMessage } from '@workspace/codec-protobuf';

import { BiomeStream } from '../biome-stream.ts';
import { appleDate } from '../biome-values.ts';

export type NotificationUsageEvent = {
  readonly notificationId: string | undefined;
  readonly occurredAt: Date | undefined;
  readonly usageType: number | undefined;
  readonly bundleId: string | undefined;
};

// A notification event, without its title or body.
export class NotificationUsage extends BiomeStream<NotificationUsageEvent> {
  readonly name = 'Notification.Usage';
  readonly maximumAgeDays = 28;

  decode(message: ProtobufMessage): NotificationUsageEvent {
    return {
      notificationId: message.string(5),
      occurredAt: appleDate(message.double(2)),
      usageType: message.uint(3),
      bundleId: message.string(4),
    };
  }
}
