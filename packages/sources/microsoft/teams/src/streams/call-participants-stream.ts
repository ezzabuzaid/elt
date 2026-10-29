import type { KeyValue } from '@zukhruf/snapshot-differential';

import type { RecordDraft } from '@workspace/elt';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const { id, accountId, nullableText } = teamsFields;

const properties = {
  accountId,
  callLogId: { ...id, description: 'The call (callLogs.id).' },
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
  readonly primaryKey = ['accountId', 'callLogId', 'participantId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per participant Teams logged for a group call; a call between two has its people in callLogs. Primary key accountId, callLogId, participantId. Kept and deleted with its call.',
    properties,
    required: Object.keys(properties),
  } as const;

  override covers(
    scan: TeamsScan,
    key: Readonly<Record<string, KeyValue>>,
  ): boolean {
    return scan.holds(
      key.accountId,
      '48:calllogs',
      key.callLogId,
      key.callLogId,
    );
  }

  protected rows(scan: TeamsScan): readonly Row[] {
    return scan.clients.flatMap(({ account, callLogs }) =>
      callLogs.flatMap(({ id, participants }) =>
        participants.map(({ id: participantId, ...participant }) => ({
          accountId: account.userId,
          callLogId: id,
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
