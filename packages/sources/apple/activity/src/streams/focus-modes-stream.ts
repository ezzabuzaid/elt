import type { RecordDraft } from '@workspace/elt';
import type { ProtobufMessage } from '@workspace/source-apple-macos/protobuf';

import { activityFields, flag, integer } from '../activity-values.ts';
import {
  type BiomeAddress,
  BiomeStream,
  biomeAddress,
} from '../biome-stream.ts';

const { text, integer: integerField } = activityFields;

const properties = {
  ...biomeAddress,
  modeId: {
    ...text,
    description: 'Identifier of the configured Focus, a UUID.',
  },
  semanticModeId: {
    ...text,
    description:
      'What kind of Focus it is, such as com.apple.focus.work or com.apple.sleep.sleep-mode.',
  },
  started: {
    ...activityFields.boolean,
    description: 'Whether the Focus turned on (true) or off (false).',
  },
  semanticType: {
    ...integerField,
    description:
      'Focus kind as stored, such as 2 Do Not Disturb, 3 Sleep, 6 Work, 8 Reading, 1 custom.',
  },
  updateReason: {
    ...integerField,
    description: 'Why the Focus changed, as stored.',
  },
  updateSource: {
    ...integerField,
    description: 'What changed the Focus, as stored.',
  },
} as const;

export class FocusModesStream extends BiomeStream<typeof properties> {
  readonly name = 'focusModes';
  readonly biomeName = 'UserFocus.ComputedMode';
  readonly retentionDays = 28;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per Focus turning on or off on this Mac (Biome UserFocus.ComputedMode).',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    payload: ProtobufMessage,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      modeId: payload.string(1),
      semanticModeId: payload.string(6),
      started: flag(payload.uint(2)),
      semanticType: integer(payload.uint(4)),
      updateReason: integer(payload.uint(3)),
      updateSource: integer(payload.uint(5)),
    };
  }
}
