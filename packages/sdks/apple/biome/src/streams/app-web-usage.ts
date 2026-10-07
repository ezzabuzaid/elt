import type { ProtobufMessage } from '@workspace/codec-protobuf';

import { BiomeStream } from '../biome-stream.ts';
import { appleDate, flag, optionalText } from '../biome-values.ts';

export type AppWebUsageEvent = {
  readonly usageId: string | undefined;
  readonly occurredAt: Date | undefined;
  readonly usageState: number | undefined;
  readonly url: string | undefined;
  readonly domain: string | undefined;
  readonly bundleId: string | undefined;
  readonly usageTrusted: boolean | undefined;
  readonly safariProfileId: string | undefined;
};

// A change of a page's usage that Screen Time counts.
export class AppWebUsage extends BiomeStream<AppWebUsageEvent> {
  readonly name = 'App.WebUsage';
  readonly maximumAgeDays = 28;

  decode(message: ProtobufMessage): AppWebUsageEvent {
    return {
      usageId: message.string(1),
      occurredAt: appleDate(message.double(2)),
      usageState: message.uint(3),
      url: message.string(4),
      domain: message.string(5),
      bundleId: message.string(6),
      usageTrusted: flag(message.uint(8)),
      safariProfileId: optionalText(message.string(9)),
    };
  }
}
