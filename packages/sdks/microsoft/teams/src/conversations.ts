import type { Fields } from './fields.ts';
import type { TeamsConversation, TeamsMember } from './teams-client.ts';

// Teams fills teamId on chats and meetings too, with the chat's own id; only
// a team's conversations and its channels belong to a team.
const inTeam = new Set(['Space', 'Topic']);

export function readConversation(conversation: Fields): TeamsConversation {
  const id = conversation.requiredString('id');
  const type = conversation.requiredString('type');
  const thread = conversation.object('threadProperties');
  const properties = conversation.object('properties');
  return {
    id,
    type,
    topic: thread?.string('topic') ?? null,
    title: conversation.object('chatTitle')?.string('longTitle') ?? null,
    description: thread?.string('description') ?? null,
    teamId: inTeam.has(type) ? conversation.string('teamId') : null,
    teamName: thread?.string('spaceThreadTopic') ?? null,
    creatorId: thread?.string('creator') ?? null,
    createdAt: thread?.milliseconds('createdat') ?? null,
    lastMessageAt: conversation.milliseconds('lastMessageTimeUtc'),
    lastReadAt: lastReadAt(properties?.string('consumptionhorizon') ?? null),
    isRead: thread?.boolean('isRead') ?? null,
    isFavorite: properties?.flag('favorite') ?? null,
    isPinned: properties?.flag('ispinned') ?? null,
    isHidden: thread?.boolean('hidden') ?? null,
    isDeleted:
      properties?.boolean('isDeleted') ?? thread?.flag('isdeleted') ?? null,
    visibility: thread?.string('visibility') ?? null,
    subType: thread?.string('threadSubType') ?? null,
    memberCount:
      conversation.object('rosterSummary')?.number('memberCount') ??
      conversation
        .object('chatTitle')
        ?.number('conversationMembersTotalCount') ??
      null,
    members: members(conversation),
    // The thread keeps the pins as JSON text; the conversation's own
    // pinnedItems copy can lag behind it, as it did on 2026-10-12 for a pin
    // just made in the notes chat.
    pinnedMessageIds: (thread?.parsedList('pinnedItems') ?? [])
      .filter((item) => item.string('itemType') === 'Message')
      .map((item) => item.requiredString('itemId')),
  };
}

// <read at>;<client time>;<client message id>, in milliseconds; 0 when the
// user has not read the conversation.
function lastReadAt(horizon: string | null): string | null {
  const readAt = Number(horizon?.split(';')[0]);
  return Number.isFinite(readAt) && readAt > 0
    ? new Date(readAt).toISOString()
    : null;
}

function members(conversation: Fields): TeamsMember[] | null {
  if (!conversation.has('members') && !conversation.has('botMembers'))
    return null;
  const byId = new Map<string, TeamsMember>();
  for (const [list, isBot] of [
    ['members', false],
    ['botMembers', true],
  ] as const)
    for (const member of conversation.list(list)) {
      const id = member.requiredString('id');
      byId.set(id, {
        id,
        role: member.string('role'),
        isBot,
        isReader: member.boolean('isReader'),
        shareHistoryAt: member.milliseconds('shareHistoryTime'),
      });
    }
  return [...byId.values()];
}
