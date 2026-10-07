import type { ProtobufMessage } from '@workspace/codec-protobuf';

import { BiomeStream } from '../biome-stream.ts';
import { flag, unixDate } from '../biome-values.ts';

export type AppMediaUsageEvent = {
  readonly usageId: string | undefined;
  readonly started: boolean | undefined;
  readonly occurredAt: Date | undefined;
  readonly bundleId: string | undefined;
  readonly usageTrusted: boolean | undefined;
};

// The start or stop of media an app played.
export class AppMediaUsage extends BiomeStream<AppMediaUsageEvent> {
  readonly name = 'App.MediaUsage';
  readonly maximumAgeDays = 28;

  decode(message: ProtobufMessage): AppMediaUsageEvent {
    return {
      usageId: message.string(8),
      started: flag(message.uint(1)),
      occurredAt: unixDate(message.double(6)),
      bundleId: message.string(2),
      usageTrusted: flag(message.uint(5)),
    };
  }
}
