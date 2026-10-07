import type { PlistValue } from '@workspace/codec-plist';
import type { ProtobufMessage } from '@workspace/codec-protobuf';

import { BiomeStream } from '../biome-stream.ts';
import { appleDate, archive, flag, optionalText } from '../biome-values.ts';

export type UserFocusInferredModeEvent = {
  readonly suggestionId: string | undefined;
  readonly occurredAt: Date | undefined;
  readonly started: boolean | undefined;
  readonly modeId: string | undefined;
  readonly modeName: string | undefined;
  readonly modeType: number | undefined;
  readonly origin: number | undefined;
  readonly automationEnabled: boolean | undefined;
  readonly uiLocation: number | undefined;
  readonly confidence: number | undefined;
  readonly shouldSuggestTriggers: boolean | undefined;
  readonly triggers: PlistValue | undefined;
};

// The start or end of a Focus the system suggested.
export class UserFocusInferredMode extends BiomeStream<UserFocusInferredModeEvent> {
  readonly name = 'UserFocus.InferredMode';
  readonly maximumAgeDays = 28;

  decode(message: ProtobufMessage): UserFocusInferredModeEvent {
    return {
      suggestionId: message.string(7),
      occurredAt: appleDate(message.double(1)),
      started: flag(message.uint(6)),
      modeId: optionalText(message.string(2)),
      modeName: optionalText(message.string(14)),
      modeType: message.uint(12),
      origin: message.uint(3),
      automationEnabled: flag(message.uint(5)),
      uiLocation: message.uint(9),
      confidence: message.double(10),
      shouldSuggestTriggers: flag(message.uint(13)),
      triggers: archive(message.bytes(11)),
    };
  }
}
