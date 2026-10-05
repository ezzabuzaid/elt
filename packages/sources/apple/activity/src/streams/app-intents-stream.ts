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

const { text, integer: integerField, nullableText } = activityFields;

const properties = {
  ...biomeAddress,
  occurredAt: {
    ...activityFields.timestamp,
    description:
      'When the interaction happened, in whole seconds; it can precede recordedAt.',
  },
  bundleId: {
    ...activityFields.bundleId,
    description: 'Bundle identifier of the app that donated the interaction.',
  },
  sourceId: { ...text, description: 'Biome intent source as stored.' },
  intentClass: {
    ...text,
    description: 'SiriKit intent class, such as INSendMessageIntent.',
  },
  intentVerb: {
    ...text,
    description: 'SiriKit intent verb, such as SendMessage.',
  },
  intentType: { ...integerField, description: 'Biome intent type as stored.' },
  handlingStatus: {
    ...integerField,
    description: 'INIntentHandlingStatus as stored.',
  },
  direction: {
    ...integerField,
    description:
      'Interaction direction as Biome stores it (1, 2 and 3 observed, mostly 3); knowledgeIntents.direction holds the INInteractionDirection value.',
  },
  donatedBySiri: {
    ...activityFields.boolean,
    description: 'Whether Siri donated the interaction rather than the app.',
  },
  itemId: {
    ...text,
    description: 'Identifier of the donated item, a UUID.',
  },
  groupId: {
    ...nullableText,
    description:
      'Group the interaction belongs to, such as a conversation; NULL when the app gave none.',
  },
  interaction: {
    ...nullableText,
    description:
      'The donated INInteraction, decoded from its keyed archive to JSON: its intent, response, date interval and participants.',
  },
} as const;

export class AppIntentsStream extends BiomeStream<typeof properties> {
  readonly name = 'appIntents';
  readonly biomeName = 'App.Intent';
  readonly retentionDays = 28;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per interaction an app donated to the system on this Mac (Biome App.Intent), such as a message sent or received through a messaging app.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    payload: ProtobufMessage,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      occurredAt: appleTime(payload.double(1)),
      bundleId: payload.string(2),
      sourceId: payload.string(3),
      intentClass: payload.string(4),
      intentVerb: payload.string(5),
      intentType: integer(payload.uint(6)),
      handlingStatus: integer(payload.uint(7)),
      direction: integer(payload.uint(11)),
      donatedBySiri: flag(payload.uint(10)),
      itemId: payload.string(9),
      groupId: nonEmpty(payload.string(12)),
      interaction: archiveJSON(payload.bytes(8)),
    };
  }
}
