import type { ProtobufMessage } from '@workspace/codec-protobuf';

import { BiomeStream } from '../biome-stream.ts';
import { flag } from '../biome-values.ts';

export type UserFocusComputedModeEvent = {
  readonly modeId: string | undefined;
  readonly semanticModeId: string | undefined;
  readonly started: boolean | undefined;
  readonly semanticType: number | undefined;
  readonly updateReason: number | undefined;
  readonly updateSource: number | undefined;
};

// A Focus turning on or off.
export class UserFocusComputedMode extends BiomeStream<UserFocusComputedModeEvent> {
  readonly name = 'UserFocus.ComputedMode';
  readonly maximumAgeDays = 28;

  decode(message: ProtobufMessage): UserFocusComputedModeEvent {
    return {
      modeId: message.string(1),
      semanticModeId: message.string(6),
      started: flag(message.uint(2)),
      semanticType: message.uint(4),
      updateReason: message.uint(3),
      updateSource: message.uint(5),
    };
  }
}
