import type { RecordDraft } from '@workspace/elt';
import type { TeamsConversation } from '@workspace/sdk-microsoft-teams';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const {
  id,
  accountId,
  nullableText,
  nullableBoolean,
  nullableInteger,
  nullableInstant,
} = teamsFields;

const properties = {
  accountId,
  id: {
    ...id,
    description:
      'Teams’ ID for the conversation, such as 19:…@thread.v2 for a chat, 19:…@thread.tacv2 for a channel, or 48:notes for the user’s own notes.',
  },
  type: {
    ...id,
    description:
      'Teams’ kind of conversation: Chat, Meeting (a meeting’s chat), Space (a team’s own conversation, its General channel), Topic (a channel), StreamOfNotes (the user’s notes), EngageCommunity, or Conversation and Thread, which Teams keeps for its own lists.',
  },
  topic: {
    ...nullableText,
    description:
      'The name its members gave it: a chat’s or meeting’s topic, a channel’s name; NULL for a chat never named.',
  },
  title: {
    ...nullableText,
    description:
      'The title Teams shows for a chat, from its members’ names when it has no topic.',
  },
  description: { ...nullableText, description: 'A channel’s description.' },
  teamId: {
    ...nullableText,
    description:
      'For a team or a channel, the team (conversations.id of the team’s Space).',
  },
  teamName: { ...nullableText, description: 'For a team, its name.' },
  creatorId: {
    ...nullableText,
    description: 'Who created it (people.mri).',
  },
  createdAt: { ...nullableInstant, description: 'When it was created.' },
  lastMessageAt: {
    ...nullableInstant,
    description: 'When its newest message arrived.',
  },
  lastReadAt: {
    ...nullableInstant,
    description: 'When the user last read it; NULL if never.',
  },
  isRead: {
    ...nullableBoolean,
    description: 'Whether the user has read its newest message.',
  },
  isFavorite: {
    ...nullableBoolean,
    description: 'Whether the user marked the channel a favorite.',
  },
  isPinned: {
    ...nullableBoolean,
    description: 'Whether the user pinned it to the top of the chat list.',
  },
  isHidden: {
    ...nullableBoolean,
    description: 'Whether the user hid it from the chat list.',
  },
  isDeleted: {
    ...nullableBoolean,
    description: 'Whether it was deleted, as a deleted channel is.',
  },
  visibility: {
    ...nullableText,
    description: 'For a team, public or private.',
  },
  subType: {
    ...nullableText,
    description: 'For a channel, its kind, such as PrivateChannel.',
  },
  memberCount: {
    ...nullableInteger,
    description: 'How many members it has, as Teams last counted.',
  },
} as const;

type Row = {
  readonly accountId: string;
  readonly conversation: TeamsConversation;
};

export class ConversationsStream extends TeamsStream<typeof properties, Row> {
  readonly name = 'conversations';
  readonly primaryKey = ['accountId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per chat, meeting chat, team and channel of the account, all of them, as Teams syncs the whole list. Primary key accountId, id. A conversation the account left or that was deleted is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: TeamsScan): readonly Row[] {
    return scan.clients.flatMap(({ account, conversations }) =>
      conversations
        .filter(({ id }) => scan.conversationSelected(id))
        .map((conversation) => ({ accountId: account.userId, conversation })),
    );
  }

  protected records({
    accountId,
    conversation: {
      members: _members,
      pinnedMessageIds: _pins,
      ...conversation
    },
  }: Row): RecordDraft<typeof properties>[] {
    return [{ accountId, ...conversation }];
  }
}
