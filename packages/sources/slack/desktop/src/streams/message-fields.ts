import type { RecordDraft } from '@workspace/elt';
import type { SlackMessage } from '@workspace/sdk-slack-desktop';

import { slackFields } from '../slack-desktop-stream.ts';

const {
  id,
  ts,
  instant,
  nullableText,
  nullableBoolean,
  nullableInteger,
  nullableTs,
  textList,
} = slackFields;

export const messageProperties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  channelId: { ...id, description: 'The conversation (channels.id).' },
  ts: {
    ...ts,
    description:
      'Slack’s ID for the message within its conversation, the time it was sent as seconds.microseconds, such as 1712345678.123456.',
  },
  sentAt: { ...instant, description: 'When it was sent: ts as an instant.' },
  type: { ...id, description: 'Slack’s message type, almost always message.' },
  subtype: {
    ...nullableText,
    description:
      'What kind of message, such as channel_join or thread_broadcast (a reply also sent to the channel); NULL for an ordinary message.',
  },
  userId: { ...nullableText, description: 'Who sent it (members.id).' },
  botId: { ...nullableText, description: 'The bot that sent it (bots.id).' },
  text: {
    ...nullableText,
    description:
      'The message in Slack’s markup: <@U…> mentions, <#C…> channels, <url|label> links.',
  },
  threadTs: {
    ...nullableTs,
    description:
      'The thread it starts or belongs to (messages.ts of the parent); equal to ts for a parent.',
  },
  replyCount: {
    ...nullableInteger,
    description: 'For a thread parent, how many replies it has.',
  },
  replyUserIds: {
    ...textList,
    description: 'For a thread parent, who replied (members.id).',
  },
  latestReplyTs: {
    ...nullableTs,
    description: 'For a thread parent, its newest reply’s ts.',
  },
  editedBy: {
    ...nullableText,
    description: 'Who last edited it (members.id).',
  },
  editedTs: {
    ...nullableTs,
    description: 'When it was last edited, as a ts; NULL when never edited.',
  },
  clientMessageId: {
    ...nullableText,
    description: 'The ID the sending app gave the message.',
  },
  isLocked: {
    ...nullableBoolean,
    description: 'Whether its thread is locked to new replies.',
  },
  isBeyondPlanLimit: {
    ...nullableBoolean,
    description:
      'Whether the workspace’s plan hides it, past the free plan’s history limit.',
  },
  savedState: {
    ...nullableText,
    description:
      'For a message the user saved for later, its state in their Later list, such as in_progress; NULL when not saved.',
  },
  savedTodoState: {
    ...nullableText,
    description:
      'For a message saved for later, Slack’s to-do state for it, such as saved.',
  },
  isSavedArchived: {
    ...nullableBoolean,
    description:
      'For a message saved for later, whether the user archived it in their Later list.',
  },
  blocks: {
    ...nullableText,
    description:
      'The message’s Block Kit blocks as JSON, as Slack holds them: rich text with its formatting, sections, buttons.',
  },
} as const;

// A message as a channel message or thread reply records it.
export function messageRecord(
  workspaceId: string,
  message: SlackMessage,
): RecordDraft<typeof messageProperties> {
  return {
    workspaceId,
    channelId: message.channelId,
    ts: message.ts,
    sentAt: message.sentAt,
    type: message.type,
    subtype: message.subtype,
    userId: message.userId,
    botId: message.botId,
    text: message.text,
    threadTs: message.threadTs,
    replyCount: message.replyCount,
    replyUserIds: [...message.replyUserIds],
    latestReplyTs: message.latestReplyTs,
    editedBy: message.editedBy,
    editedTs: message.editedTs,
    clientMessageId: message.clientMessageId,
    isLocked: message.isLocked,
    isBeyondPlanLimit: message.isBeyondPlanLimit,
    savedState: message.savedState,
    savedTodoState: message.savedTodoState,
    isSavedArchived: message.isSavedArchived,
    blocks: message.blocksJson,
  };
}
