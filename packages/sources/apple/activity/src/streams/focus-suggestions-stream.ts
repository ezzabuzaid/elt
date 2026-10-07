import type { RecordDraft } from '@workspace/elt';
import {
  UserFocusInferredMode,
  type UserFocusInferredModeEvent,
} from '@workspace/sdk-apple-biome';

import { activityFields, isoTime, plistText } from '../activity-values.ts';
import {
  BiomeActivityStream,
  type BiomeAddress,
  biomeAddress,
} from '../biome-activity-stream.ts';

const { text, nullableText, integer: integerField } = activityFields;

const properties = {
  ...biomeAddress,
  suggestionId: {
    ...text,
    description:
      'Identifier of one suggestion; the records that start and end it share it.',
  },
  occurredAt: {
    ...activityFields.timestamp,
    description: 'When the suggestion started or ended.',
  },
  started: {
    ...activityFields.boolean,
    description: 'Whether the suggestion started (true) or ended (false).',
  },
  modeId: {
    ...nullableText,
    description:
      'The Focus suggested, a UUID; recorded on starts only, NULL on ends.',
  },
  modeName: {
    ...nullableText,
    description:
      'Name of the Focus suggested, such as Work; recorded on starts only.',
  },
  modeType: { ...integerField, description: 'Focus mode type as stored.' },
  origin: {
    ...integerField,
    description: 'What prompted the suggestion, as stored.',
  },
  automationEnabled: {
    ...activityFields.boolean,
    description: 'Whether the Focus turns on automatically.',
  },
  uiLocation: {
    ...integerField,
    description: 'Where the suggestion was shown, as stored.',
  },
  confidence: {
    ...activityFields.number,
    description: 'Confidence of the suggestion, 0 to 1.',
  },
  shouldSuggestTriggers: {
    ...activityFields.boolean,
    description: 'Whether the system suggested triggers for the Focus.',
  },
  triggers: {
    ...nullableText,
    description:
      'The triggers behind the suggestion, decoded from their keyed archive to JSON; NULL when none.',
  },
} as const;

export class FocusSuggestionsStream extends BiomeActivityStream<
  typeof properties,
  UserFocusInferredModeEvent
> {
  readonly name = 'focusSuggestions';
  readonly biome = new UserFocusInferredMode();
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per start or end of a Focus the system inferred and suggested on this Mac (Biome UserFocus.InferredMode).',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: UserFocusInferredModeEvent,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      suggestionId: event.suggestionId,
      occurredAt: isoTime(event.occurredAt),
      started: event.started ?? null,
      modeId: event.modeId ?? null,
      modeName: event.modeName ?? null,
      modeType: event.modeType ?? null,
      origin: event.origin ?? null,
      automationEnabled: event.automationEnabled ?? null,
      uiLocation: event.uiLocation ?? null,
      confidence: event.confidence,
      shouldSuggestTriggers: event.shouldSuggestTriggers ?? null,
      triggers: plistText(event.triggers),
    };
  }
}
