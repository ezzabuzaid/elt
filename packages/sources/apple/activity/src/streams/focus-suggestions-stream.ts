import type { ProtobufMessage } from '@workspace/codec-protobuf';
import type { RecordDraft } from '@workspace/elt';

import {
  activityFields,
  appleTime,
  archiveJSON,
  flag,
  integer,
  nonEmpty,
} from '../activity-values.ts';
import {
  type BiomeAddress,
  BiomeStream,
  biomeAddress,
} from '../biome-stream.ts';

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

export class FocusSuggestionsStream extends BiomeStream<typeof properties> {
  readonly name = 'focusSuggestions';
  readonly biomeName = 'UserFocus.InferredMode';
  readonly retentionDays = 28;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per start or end of a Focus the system inferred and suggested on this Mac (Biome UserFocus.InferredMode).',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    payload: ProtobufMessage,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      suggestionId: payload.string(7),
      occurredAt: appleTime(payload.double(1)),
      started: flag(payload.uint(6)),
      modeId: nonEmpty(payload.string(2)),
      modeName: nonEmpty(payload.string(14)),
      modeType: integer(payload.uint(12)),
      origin: integer(payload.uint(3)),
      automationEnabled: flag(payload.uint(5)),
      uiLocation: integer(payload.uint(9)),
      confidence: payload.double(10),
      shouldSuggestTriggers: flag(payload.uint(13)),
      triggers: archiveJSON(payload.bytes(11)),
    };
  }
}
