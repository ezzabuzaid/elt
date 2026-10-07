import type { RecordDraft } from '@workspace/elt';
import { AppIntent, type AppIntentEvent } from '@workspace/sdk-apple-biome';

import { activityFields, isoTime, plistText } from '../activity-values.ts';
import {
  BiomeActivityStream,
  type BiomeAddress,
  biomeAddress,
} from '../biome-activity-stream.ts';

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

export class AppIntentsStream extends BiomeActivityStream<
  typeof properties,
  AppIntentEvent
> {
  readonly name = 'appIntents';
  readonly biome = new AppIntent();
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per interaction an app donated to the system on this Mac (Biome App.Intent), such as a message sent or received through a messaging app.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: AppIntentEvent,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      occurredAt: isoTime(event.occurredAt),
      bundleId: event.bundleId,
      sourceId: event.sourceId,
      intentClass: event.intentClass,
      intentVerb: event.intentVerb,
      intentType: event.intentType ?? null,
      handlingStatus: event.handlingStatus ?? null,
      direction: event.direction ?? null,
      donatedBySiri: event.donatedBySiri ?? null,
      itemId: event.itemId,
      groupId: event.groupId ?? null,
      interaction: plistText(event.interaction),
    };
  }
}
