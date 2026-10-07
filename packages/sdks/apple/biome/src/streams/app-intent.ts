import type { PlistValue } from '@workspace/codec-plist';
import type { ProtobufMessage } from '@workspace/codec-protobuf';

import { BiomeStream } from '../biome-stream.ts';
import { appleDate, archive, flag, optionalText } from '../biome-values.ts';

export type AppIntentEvent = {
  readonly occurredAt: Date | undefined;
  readonly bundleId: string | undefined;
  readonly sourceId: string | undefined;
  readonly intentClass: string | undefined;
  readonly intentVerb: string | undefined;
  readonly intentType: number | undefined;
  readonly handlingStatus: number | undefined;
  readonly direction: number | undefined;
  readonly donatedBySiri: boolean | undefined;
  readonly itemId: string | undefined;
  readonly groupId: string | undefined;
  // The donated INInteraction, unarchived.
  readonly interaction: PlistValue | undefined;
};

// An interaction an app donated to the system.
export class AppIntent extends BiomeStream<AppIntentEvent> {
  readonly name = 'App.Intent';
  readonly maximumAgeDays = 28;

  decode(message: ProtobufMessage): AppIntentEvent {
    return {
      occurredAt: appleDate(message.double(1)),
      bundleId: message.string(2),
      sourceId: message.string(3),
      intentClass: message.string(4),
      intentVerb: message.string(5),
      intentType: message.uint(6),
      handlingStatus: message.uint(7),
      direction: message.uint(11),
      donatedBySiri: flag(message.uint(10)),
      itemId: message.string(9),
      groupId: optionalText(message.string(12)),
      interaction: archive(message.bytes(8)),
    };
  }
}
