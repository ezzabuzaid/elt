import type { RecordDraft } from '@workspace/elt';
import type { SaintDavidsCount } from '@workspace/sdk-apple-call-history';

import {
  AppleCallHistoryStream,
  callHistoryFields,
} from '../apple-call-history-stream.ts';
import type { CallHistoryScan } from '../call-history-scan.ts';

const { integer, nullableId, nullableInteger } = callHistoryFields;

const properties = {
  id: {
    ...integer,
    description:
      'The store’s row number for the count (ZSAINTDAVIDSCOUNTS.Z_PK); the primary key. Its call is optional in Apple’s model, so no call-based key is guaranteed.',
  },
  callId: {
    ...nullableId,
    description:
      'The call counted; refers to calls.id within this source. NULL when the count names no call.',
  },
  type: {
    ...nullableInteger,
    description:
      'The type code counted (ZSAINTDAVIDSCOUNTS.ZTYPE), whose values Apple does not document; NULL when none is stored.',
  },
  count: {
    ...nullableInteger,
    description:
      'The count (ZSAINTDAVIDSCOUNTS.ZCOUNT); NULL when none is stored.',
  },
} as const;

export class SaintDavidsCountsStream extends AppleCallHistoryStream<
  typeof properties,
  SaintDavidsCount
> {
  readonly name = 'saintDavidsCounts';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per count CallHistory keeps for a call and type code, in its SaintDavidsCounts entity. Apple names neither the feature nor its codes, so values are kept as stored. Primary key id.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: CallHistoryScan): readonly SaintDavidsCount[] {
    return scan.saintDavidsCounts;
  }

  protected records(count: SaintDavidsCount): RecordDraft<typeof properties>[] {
    return [{ ...count }];
  }
}
