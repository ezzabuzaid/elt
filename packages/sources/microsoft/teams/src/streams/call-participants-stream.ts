import type { VanishedRecord } from '@zukhruf/snapshot-differential';

import type { RecordDraft } from '@eltjs/elt';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, feedPlace, teamsFields } from '../teams-stream.ts';

const { id, accountId, position, nullableText } = teamsFields;

const properties = {
  accountId,
  // The call's place (callLogs.store, recordId, entry).
  ...feedPlace,
  position: {
    ...position,
    description: 'The participant’s place in the call’s list, from 0.',
  },
  participantId: {
    ...id,
    description: 'Who took part (people.mri), or a service such as call park.',
  },
  type: { ...nullableText, description: 'default, or the service’s kind.' },
  tenantId: {
    ...nullableText,
    description: 'The participant’s organization (accounts.tenantId).',
  },
} as const;

type Row = RecordDraft<typeof properties>;

export class CallParticipantsStream extends TeamsStream<
  typeof properties,
  Row
> {
  readonly name = 'callParticipants';
  readonly primaryKey = ['accountId', 'store', 'recordId', 'entry', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per place in the list of participants Teams logged for a group call; a call between two has its people in callLogs. Primary key accountId, store, recordId, entry (its call’s place) and position. Kept and deleted with its call.',
    properties,
    required: Object.keys(properties),
  } as const;

  override covers(scan: TeamsScan, { key }: VanishedRecord): boolean {
    return scan.holds(key.accountId, '48:calllogs', key.recordId, key.recordId);
  }

  protected rows(scan: TeamsScan): readonly Row[] {
    return scan.clients.flatMap(({ account, callLogs }) =>
      callLogs.flatMap(({ place: { store, recordId, entry }, participants }) =>
        participants.map(({ id: participantId, ...participant }) => ({
          accountId: account.userId,
          store,
          recordId,
          entry,
          participantId,
          ...participant,
        })),
      ),
    );
  }

  protected records(row: Row): Row[] {
    return [row];
  }
}
