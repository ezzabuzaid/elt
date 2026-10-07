import type { RecordDraft } from '@workspace/elt';
import {
  AppIntents,
  type AppIntentsEvent,
  type KnowledgeEvent,
} from '@workspace/sdk-apple-knowledge';

import { activityFields, plistText } from '../activity-values.ts';
import {
  KnowledgeActivityStream,
  knowledgeEvent,
  knowledgeEventRecord,
} from '../knowledge-activity-stream.ts';

const { text, nullableText, integer: integerField } = activityFields;

const properties = {
  ...knowledgeEvent,
  category: {
    ...nullableText,
    description:
      'What the interaction was about, such as Messages, Calls or Media; NULL when knowledgeC recorded none.',
  },
  bundleId: {
    ...activityFields.bundleId,
    description: 'Bundle identifier of the app that donated the interaction.',
  },
  deviceId: {
    ...nullableText,
    description: 'knowledgeC identifier of the device the event came from.',
  },
  itemId: {
    ...nullableText,
    description: 'Identifier the app gave the interaction.',
  },
  groupId: {
    ...nullableText,
    description:
      'Group the interaction belongs to, such as a conversation; NULL when the app gave none.',
  },
  intentClass: {
    ...text,
    description: 'SiriKit intent class, such as INSendMessageIntent.',
  },
  intentVerb: {
    ...nullableText,
    description: 'SiriKit intent verb, such as SendMessage.',
  },
  intentType: { ...integerField, description: 'Intent type as stored.' },
  handlingStatus: {
    ...integerField,
    description: 'INIntentHandlingStatus as stored.',
  },
  direction: {
    ...integerField,
    description:
      'INInteractionDirection as stored: 0 unspecified, 1 outgoing, 2 incoming.',
  },
  donatedBySiri: {
    ...activityFields.boolean,
    description: 'Whether Siri donated the interaction rather than the app.',
  },
  interactionId: {
    ...text,
    description: 'Identifier of the INInteraction.',
  },
  derivedIntentId: {
    ...nullableText,
    description: 'Identifier the system derived for the intent.',
  },
  relatedContactIds: {
    ...nullableText,
    description:
      'Contacts the interaction involved, as knowledgeC stores them; NULL when none.',
  },
  interaction: {
    ...nullableText,
    description:
      'The donated INInteraction, decoded from its keyed archive to JSON: its intent, response, date interval and participants.',
  },
} as const;

export class KnowledgeIntentsStream extends KnowledgeActivityStream<
  typeof properties,
  AppIntentsEvent
> {
  readonly name = 'knowledgeIntents';
  readonly knowledge = new AppIntents();
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per app interaction in knowledgeC (/app/intents), such as a message or call in a messaging app. On a Mac these arrive from the user’s iPhone through knowledge sync.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: KnowledgeEvent & AppIntentsEvent,
  ): RecordDraft<typeof properties> {
    return {
      ...knowledgeEventRecord(event),
      category: event.category ?? null,
      bundleId: event.bundleId,
      deviceId: event.deviceId ?? null,
      itemId: event.itemId ?? null,
      groupId: event.groupId ?? null,
      intentClass: event.intentClass,
      intentVerb: event.intentVerb ?? null,
      intentType: event.intentType ?? null,
      handlingStatus: event.handlingStatus ?? null,
      direction: event.direction ?? null,
      donatedBySiri: event.donatedBySiri ?? null,
      interactionId: event.interactionId,
      derivedIntentId: event.derivedIntentId ?? null,
      relatedContactIds: event.relatedContactIds ?? null,
      interaction: plistText(event.interaction),
    };
  }
}
