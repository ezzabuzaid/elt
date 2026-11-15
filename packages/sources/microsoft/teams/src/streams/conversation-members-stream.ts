import type { VanishedRecord } from '@zukhruf/snapshot-differential';

import type { RecordDraft } from '@eltjs/elt';
import type { TeamsMember } from '@eltjs/sdk-microsoft-teams';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const {
  id,
  accountId,
  position,
  conversationId,
  nullableText,
  nullableBoolean,
  nullableInstant,
} = teamsFields;

const properties = {
  accountId,
  conversationId,
  list: {
    type: 'string',
    enum: ['members', 'botMembers'],
    description:
      'The conversation’s list that names the member: members, or botMembers for a bot.',
  },
  position: {
    ...position,
    description: 'The member’s place in that list, from 0.',
  },
  memberId: {
    ...id,
    description:
      'The member’s Teams ID: 8:orgid:<id> for a person (people.mri), 28:<id> for a bot.',
  },
  role: { ...nullableText, description: 'Admin or User.' },
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
  readonly primaryKey = ['accountId', 'conversationId', 'list', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per place in the lists of members of a chat, meeting chat or team, as Teams keeps them; a channel’s members are its team’s. Primary key accountId, conversationId, list, position. A member who left is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  override covers(scan: TeamsScan, { key }: VanishedRecord): boolean {
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
