import type { RecordDraft } from '@workspace/elt';
import type {
  TeamsMessage,
  TeamsReaction,
} from '@workspace/sdk-microsoft-teams';

import { teamsFields } from '../teams-stream.ts';
import {
  MessageChildStream,
  type Part,
  messageKey,
} from './message-child-stream.ts';

const { id, nullableInstant } = teamsFields;

const properties = {
  ...messageKey,
  emoji: {
    ...id,
    description:
      'The reaction as Teams names it, such as like, heart or laugh.',
  },
  userId: { ...id, description: 'Who reacted (people.mri).' },
  reactedAt: { ...nullableInstant, description: 'When they reacted.' },
} as const;

export class MessageReactionsStream extends MessageChildStream<
  typeof properties,
  TeamsReaction
> {
  readonly name = 'messageReactions';
  readonly primaryKey = [
    'accountId',
    'conversationId',
    'threadId',
    'messageId',
    'emoji',
    'userId',
  ];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per person’s reaction to a message. Primary key accountId, conversationId, threadId, messageId, emoji, userId. A reaction taken back from a message the app still holds is deleted; reactions of a message the app dropped from its cache stay.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected children({ reactions }: TeamsMessage): readonly TeamsReaction[] {
    return reactions;
  }

  protected records({
    key,
    child: reaction,
  }: Part<TeamsReaction>): RecordDraft<typeof properties>[] {
    return [{ ...key, ...reaction }];
  }
}
