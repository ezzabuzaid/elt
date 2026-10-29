import type { KeyValue } from '@zukhruf/snapshot-differential';

import type { RecordDraft } from '@workspace/elt';
import type { TeamsMember } from '@workspace/sdk-microsoft-teams';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const {
  id,
  accountId,
  conversationId,
  nullableText,
  nullableBoolean,
  nullableInstant,
} = teamsFields;

const properties = {
  accountId,
  conversationId,
  memberId: {
    ...id,
    description:
      'The member’s Teams ID: 8:orgid:<id> for a person (people.mri), 28:<id> for a bot.',
  },
  role: { ...nullableText, description: 'Admin or User.' },
  isBot: { type: 'boolean', description: 'Whether the member is a bot.' },
  isReader: {
    ...nullableBoolean,
    description: 'Whether the member can only read.',
  },
  shareHistoryAt: {
    ...nullableInstant,
    description:
      'From when the member sees the conversation’s history, for one added later.',
  },
} as const;

type Row = {
  readonly accountId: string;
  readonly conversationId: string;
  readonly member: TeamsMember;
};

export class ConversationMembersStream extends TeamsStream<
  typeof properties,
  Row
> {
  readonly name = 'conversationMembers';
  readonly primaryKey = ['accountId', 'conversationId', 'memberId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per member of a chat, meeting chat or team, as Teams keeps them; a channel’s members are its team’s. Primary key accountId, conversationId, memberId. A member who left is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  override covers(
    scan: TeamsScan,
    key: Readonly<Record<string, KeyValue>>,
  ): boolean {
    return scan.holdsMembers(key.accountId, key.conversationId);
  }

  protected rows(scan: TeamsScan): readonly Row[] {
    return scan.clients.flatMap(({ account, conversations }) =>
      conversations
        .filter(({ id }) => scan.conversationSelected(id))
        .flatMap(({ id, members }) =>
          (members ?? []).map((member) => ({
            accountId: account.userId,
            conversationId: id,
            member,
          })),
        ),
    );
  }

  protected records({
    member: { id, ...member },
    ...row
  }: Row): RecordDraft<typeof properties>[] {
    return [{ ...row, memberId: id, ...member }];
  }
}
