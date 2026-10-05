import type { RecordDraft } from '@workspace/elt';

import {
  type Row,
  activityFields,
  appleTime,
  archiveJSON,
  flag,
  integer,
  nonEmpty,
} from '../activity-values.ts';
import { KnowledgeStream, knowledgeEvent } from '../knowledge-stream.ts';

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

export class KnowledgeIntentsStream extends KnowledgeStream<typeof properties> {
  readonly name = 'knowledgeIntents';
  readonly streamName = '/app/intents';
  readonly retentionDays = 28;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per app interaction in knowledgeC (/app/intents), such as a message or call in a messaging app. On a Mac these arrive from the user’s iPhone through knowledge sync.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected readonly columns = `o.ZVALUESTRING, s.ZBUNDLEID, s.ZDEVICEID, s.ZITEMID, s.ZGROUPID,
    m.Z_DKINTENTMETADATAKEY__INTENTCLASS, m.Z_DKINTENTMETADATAKEY__INTENTVERB,
    m.Z_DKINTENTMETADATAKEY__INTENTTYPE, m.Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS,
    m.Z_DKINTENTMETADATAKEY__DIRECTION, m.Z_DKINTENTMETADATAKEY__DONATEDBYSIRI,
    m.Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER, m.Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER,
    m.Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS, m.Z_DKINTENTMETADATAKEY__SERIALIZEDINTERACTION`;

  protected record(row: Row): RecordDraft<typeof properties> {
    return {
      id: row.ZUUID,
      startedAt: appleTime(row.ZSTARTDATE),
      endedAt: appleTime(row.ZENDDATE),
      createdAt: appleTime(row.ZCREATIONDATE),
      utcOffsetSeconds: row.ZSECONDSFROMGMT,
      category: nonEmpty(row.ZVALUESTRING),
      bundleId: row.ZBUNDLEID,
      deviceId: nonEmpty(row.ZDEVICEID),
      itemId: nonEmpty(row.ZITEMID),
      groupId: nonEmpty(row.ZGROUPID),
      intentClass: row.Z_DKINTENTMETADATAKEY__INTENTCLASS,
      intentVerb: nonEmpty(row.Z_DKINTENTMETADATAKEY__INTENTVERB),
      intentType: integer(row.Z_DKINTENTMETADATAKEY__INTENTTYPE),
      handlingStatus: integer(row.Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS),
      direction: integer(row.Z_DKINTENTMETADATAKEY__DIRECTION),
      donatedBySiri: flag(row.Z_DKINTENTMETADATAKEY__DONATEDBYSIRI),
      interactionId: row.Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER,
      derivedIntentId: nonEmpty(
        row.Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER,
      ),
      relatedContactIds: nonEmpty(
        row.Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS,
      ),
      interaction: archiveJSON(
        row.Z_DKINTENTMETADATAKEY__SERIALIZEDINTERACTION,
      ),
    };
  }
}
