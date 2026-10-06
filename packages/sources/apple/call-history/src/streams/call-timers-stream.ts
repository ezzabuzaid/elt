import type { RecordDraft } from '@workspace/elt';
import type { CallTimers } from '@workspace/sdk-apple-call-history';

import {
  AppleCallHistoryStream,
  callHistoryFields,
} from '../apple-call-history-stream.ts';
import type { CallHistoryScan } from '../call-history-scan.ts';

const { integer, nullableSeconds } = callHistoryFields;
const timer = (what: string, column: string) =>
  `${what}, in seconds (ZCALLDBPROPERTIES.${column}); NULL when not stored.`;

const properties = {
  id: {
    ...integer,
    description:
      'The store’s row number for these totals (ZCALLDBPROPERTIES.Z_PK); the primary key. The store keeps one row.',
  },
  all: {
    ...nullableSeconds,
    description: timer(
      'Call time since the totals were last reset',
      'ZTIMER_ALL',
    ),
  },
  incoming: {
    ...nullableSeconds,
    description: timer('Incoming call time', 'ZTIMER_INCOMING'),
  },
  outgoing: {
    ...nullableSeconds,
    description: timer('Outgoing call time', 'ZTIMER_OUTGOING'),
  },
  last: {
    ...nullableSeconds,
    description: timer('The last call’s time', 'ZTIMER_LAST'),
  },
  lifetime: {
    ...nullableSeconds,
    description: timer(
      'Call time over the life of the store',
      'ZTIMER_LIFETIME',
    ),
  },
} as const;

export class CallTimersStream extends AppleCallHistoryStream<
  typeof properties,
  CallTimers
> {
  readonly name = 'callTimers';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'The call-time totals the Phone app keeps, one record for the store. Primary key id. Not narrowed by an import’s date range: the totals span every call.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: CallHistoryScan): readonly CallTimers[] {
    return scan.timers;
  }

  protected records(timers: CallTimers): RecordDraft<typeof properties>[] {
    return [{ ...timers }];
  }
}
