import type { KeyValue, RecordDraft } from '@workspace/elt';
import type { TeamsCallLog } from '@workspace/sdk-microsoft-teams';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const { id, accountId, nullableText, nullablePreciseInstant } = teamsFields;

const properties = {
  accountId,
  id: {
    ...id,
    description:
      'The entry’s ID in Teams’ call history, when it was logged in milliseconds since 1970.',
  },
  callId: { ...id, description: 'The calling service’s ID for the call.' },
  startedAt: { ...nullablePreciseInstant, description: 'When it rang.' },
  connectedAt: {
    ...nullablePreciseInstant,
    description: 'When it was answered; NULL if it never was.',
  },
  endedAt: { ...nullablePreciseInstant, description: 'When it ended.' },
  direction: { ...nullableText, description: 'incoming or outgoing.' },
  callType: {
    ...nullableText,
    description: 'twoParty for a call between two, multiParty for a meeting.',
  },
  state: { ...nullableText, description: 'accepted, declined or missed.' },
  originatorId: {
    ...nullableText,
    description: 'Who placed it (people.mri).',
  },
  originatorName: {
    ...nullableText,
    description: 'The caller’s name as logged.',
  },
  targetId: { ...nullableText, description: 'Who was called (people.mri).' },
  targetType: {
    ...nullableText,
    description: 'default, or voicemail when the call went there.',
  },
  conversationId: {
    ...nullableText,
    description: 'The meeting chat it took place in (conversations.id).',
  },
  messageId: {
    ...nullableText,
    description: 'Its message in that chat (messages.id).',
  },
  forwardedTo: {
    ...nullableText,
    description: 'Where it was forwarded unanswered, such as voicemail.',
  },
} as const;

type Row = { readonly accountId: string; readonly log: TeamsCallLog };

export class CallLogsStream extends TeamsStream<typeof properties, Row> {
  readonly name = 'callLogs';
  readonly primaryKey = ['accountId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per call in the account’s Teams call history that the app holds. Primary key accountId, id. An entry removed from the part of the history the app still holds is deleted; one the app dropped from its cache stays.',
    properties,
    required: Object.keys(properties),
  } as const;

  override covers(
    scan: TeamsScan,
    key: Readonly<Record<string, KeyValue>>,
  ): boolean {
    return scan.holds(key.accountId, '48:calllogs', key.id, key.id);
  }

  protected rows(scan: TeamsScan): readonly Row[] {
    return scan.clients.flatMap(({ account, callLogs }) =>
      callLogs.map((log) => ({ accountId: account.userId, log })),
    );
  }

  protected records({
    accountId,
    log: { participants: _participants, ...log },
  }: Row): RecordDraft<typeof properties>[] {
    return [{ accountId, ...log }];
  }
}
