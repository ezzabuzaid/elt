import type { ProtobufMessage } from '@workspace/codec-protobuf';

import { BiomeStream } from '../biome-stream.ts';
import { flag, unixDate } from '../biome-values.ts';

export type ScreenTimeAppUsageEvent = {
  readonly started: boolean | undefined;
  readonly occurredAt: Date | undefined;
  readonly bundleId: string | undefined;
  readonly usageTrusted: boolean | undefined;
};

// The start or end of usage Screen Time counts.
export class ScreenTimeAppUsage extends BiomeStream<ScreenTimeAppUsageEvent> {
  readonly name = 'ScreenTime.AppUsage';
  readonly maximumAgeDays = 28;

  decode(message: ProtobufMessage): ScreenTimeAppUsageEvent {
    return {
      started: flag(message.uint(1)),
      occurredAt: unixDate(message.double(2)),
      bundleId: message.string(3),
      usageTrusted: flag(message.uint(5)),
    };
  }
}
