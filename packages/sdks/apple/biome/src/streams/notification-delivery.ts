import type { ProtobufMessage } from '@workspace/codec-protobuf';

import { BiomeStream } from '../biome-stream.ts';
import { unixDate } from '../biome-values.ts';

export type NotificationDeliveryEvent = {
  readonly requestId: string | undefined;
  readonly bundleId: string | undefined;
  readonly occurredAt: Date | undefined;
};

// A notification delivered.
export class NotificationDelivery extends BiomeStream<NotificationDeliveryEvent> {
  readonly name = 'Notification.Delivery';
  readonly maximumAgeDays = 3;

  decode(message: ProtobufMessage): NotificationDeliveryEvent {
    return {
      requestId: message.string(1),
      bundleId: message.string(2),
      occurredAt: unixDate(message.double(3)),
    };
  }
}
