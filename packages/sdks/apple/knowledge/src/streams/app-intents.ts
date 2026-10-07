import type { PlistValue } from '@workspace/codec-plist';

import { type KnowledgeRow, KnowledgeStream } from '../knowledge-stream.ts';
import {
  archive,
  flag,
  integer,
  optionalText,
  text,
} from '../knowledge-values.ts';

export type AppIntentsEvent = {
  // What the interaction was about, such as Messages, Calls or Media.
  readonly category: string | undefined;
  readonly bundleId: string | undefined;
  readonly deviceId: string | undefined;
  readonly itemId: string | undefined;
  readonly groupId: string | undefined;
  readonly intentClass: string | undefined;
  readonly intentVerb: string | undefined;
  readonly intentType: number | undefined;
  readonly handlingStatus: number | undefined;
  readonly direction: number | undefined;
  readonly donatedBySiri: boolean | undefined;
  readonly interactionId: string | undefined;
  readonly derivedIntentId: string | undefined;
  readonly relatedContactIds: string | undefined;
  // The donated INInteraction, unarchived.
  readonly interaction: PlistValue | undefined;
};

// An app interaction; on a Mac they arrive from the iPhone through knowledge
// sync.
export class AppIntents extends KnowledgeStream<AppIntentsEvent> {
  readonly name = '/app/intents';
  readonly maximumAgeDays = 28;
  readonly columns = {
    ZOBJECT: ['ZVALUESTRING'],
    ZSOURCE: ['ZBUNDLEID', 'ZDEVICEID', 'ZITEMID', 'ZGROUPID'],
    ZSTRUCTUREDMETADATA: [
      'Z_DKINTENTMETADATAKEY__INTENTCLASS',
      'Z_DKINTENTMETADATAKEY__INTENTVERB',
      'Z_DKINTENTMETADATAKEY__INTENTTYPE',
      'Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS',
      'Z_DKINTENTMETADATAKEY__DIRECTION',
      'Z_DKINTENTMETADATAKEY__DONATEDBYSIRI',
      'Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER',
      'Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER',
      'Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS',
      'Z_DKINTENTMETADATAKEY__SERIALIZEDINTERACTION',
    ],
  };

  decode(row: KnowledgeRow): AppIntentsEvent {
    return {
      category: optionalText(row.ZVALUESTRING),
      bundleId: text(row.ZBUNDLEID),
      deviceId: optionalText(row.ZDEVICEID),
      itemId: optionalText(row.ZITEMID),
      groupId: optionalText(row.ZGROUPID),
      intentClass: text(row.Z_DKINTENTMETADATAKEY__INTENTCLASS),
      intentVerb: optionalText(row.Z_DKINTENTMETADATAKEY__INTENTVERB),
      intentType: integer(row.Z_DKINTENTMETADATAKEY__INTENTTYPE),
      handlingStatus: integer(row.Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS),
      direction: integer(row.Z_DKINTENTMETADATAKEY__DIRECTION),
      donatedBySiri: flag(row.Z_DKINTENTMETADATAKEY__DONATEDBYSIRI),
      interactionId: text(row.Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER),
      derivedIntentId: optionalText(
        row.Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER,
      ),
      relatedContactIds: optionalText(
        row.Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS,
      ),
      interaction: archive(row.Z_DKINTENTMETADATAKEY__SERIALIZEDINTERACTION),
    };
  }
}
