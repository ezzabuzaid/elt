import type { RecordDraft } from '@workspace/elt';
import type { EmergencyMediaItem } from '@workspace/sdk-apple-call-history';

import {
  AppleCallHistoryStream,
  callHistoryFields,
} from '../apple-call-history-stream.ts';
import type { CallHistoryScan } from '../call-history-scan.ts';

const { integer, nullableId, nullableInteger, nullableText } =
  callHistoryFields;

const properties = {
  id: {
    ...integer,
    description:
      'The store’s row number for the item (ZEMERGENCYMEDIAITEM.Z_PK); the primary key. Its call is optional in Apple’s model, so no call-based key is guaranteed.',
  },
  callId: {
    ...nullableId,
    description:
      'The call the media was uploaded for; refers to calls.id within this source. NULL when the item names no call.',
  },
  mediaType: {
    ...nullableInteger,
    description:
      'CallHistory’s media type code (ZEMERGENCYMEDIAITEM.ZEMERGENCYMEDIATYPE), whose values Apple does not document; NULL when none is stored.',
  },
  assetId: {
    ...nullableText,
    description:
      'The uploaded media asset’s identifier (ZEMERGENCYMEDIAITEM.ZASSETID); NULL when not stored.',
  },
} as const;

export class EmergencyMediaItemsStream extends AppleCallHistoryStream<
  typeof properties,
  EmergencyMediaItem
> {
  readonly name = 'emergencyMediaItems';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per photo or video shared with emergency services during an emergency call. Primary key id.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: CallHistoryScan): readonly EmergencyMediaItem[] {
    return scan.emergencyMediaItems;
  }

  protected records(
    item: EmergencyMediaItem,
  ): RecordDraft<typeof properties>[] {
    return [{ ...item }];
  }
}
