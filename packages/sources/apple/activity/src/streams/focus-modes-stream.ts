import type { RecordDraft } from '@workspace/elt';
import {
  UserFocusComputedMode,
  type UserFocusComputedModeEvent,
} from '@workspace/sdk-apple-biome';

import { activityFields } from '../activity-values.ts';
import {
  BiomeActivityStream,
  type BiomeAddress,
  biomeAddress,
} from '../biome-activity-stream.ts';

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

export class FocusModesStream extends BiomeActivityStream<
  typeof properties,
  UserFocusComputedModeEvent
> {
  readonly name = 'focusModes';
  readonly biome = new UserFocusComputedMode();
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per Focus turning on or off on this Mac (Biome UserFocus.ComputedMode).',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: UserFocusComputedModeEvent,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      modeId: event.modeId,
      semanticModeId: event.semanticModeId,
      started: event.started ?? null,
      semanticType: event.semanticType ?? null,
      updateReason: event.updateReason ?? null,
      updateSource: event.updateSource ?? null,
    };
  }
}
