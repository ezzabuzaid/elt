import type { ProtobufMessage } from '@workspace/codec-protobuf';

import { BiomeStream } from '../biome-stream.ts';
import { appleDate, flag, optionalText } from '../biome-values.ts';

export type AppInFocusEvent = {
  readonly started: boolean | undefined;
  readonly occurredAt: Date | undefined;
  readonly bundleId: string | undefined;
  readonly launchReason: string | undefined;
  readonly eventType: number | undefined;
  readonly shortVersion: string | undefined;
  readonly bundleVersion: string | undefined;
  readonly platform: number | undefined;
  readonly nativeArchitecture: boolean | undefined;
  readonly displayType: number | undefined;
};

// An app coming into or leaving the foreground.
export class AppInFocus extends BiomeStream<AppInFocusEvent> {
  readonly name = 'App.InFocus';
  readonly maximumAgeDays = 28;

  decode(message: ProtobufMessage): AppInFocusEvent {
    return {
      started: flag(message.uint(3)),
      occurredAt: appleDate(message.double(4)),
      bundleId: message.string(6),
      launchReason: optionalText(message.string(1)),
      eventType: message.uint(2),
      shortVersion: optionalText(message.string(9)),
      bundleVersion: optionalText(message.string(10)),
      platform: message.uint(11),
      nativeArchitecture: flag(message.uint(12)),
      displayType: message.uint(13),
    };
  }
}
