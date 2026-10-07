import type { ProtobufMessage } from '@workspace/codec-protobuf';

import { BiomeStream } from '../biome-stream.ts';
import { unixDate } from '../biome-values.ts';

export type SafariNavigationsEvent = {
  readonly host: string | undefined;
  readonly url: string | undefined;
  readonly countryCode: string | undefined;
  // Safari reports a navigation's time rounded up to the half hour.
  readonly periodEndsAt: Date | undefined;
};

// A navigation Safari reports.
export class SafariNavigations extends BiomeStream<SafariNavigationsEvent> {
  readonly name = 'Safari.Navigations';
  readonly maximumAgeDays = 28;

  decode(message: ProtobufMessage): SafariNavigationsEvent {
    return {
      host: message.string(1),
      url: message.string(8),
      countryCode: message.string(5),
      periodEndsAt: unixDate(message.double(2)),
    };
  }
}
