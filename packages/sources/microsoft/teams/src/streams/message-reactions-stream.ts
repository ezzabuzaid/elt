import type { RecordDraft } from '@eltjs/elt';
import type { TeamsMessage, TeamsReaction } from '@eltjs/sdk-microsoft-teams';

import { teamsFields } from '../teams-stream.ts';
import {
  MessageChildStream,
  type Part,
  messageKey,
  messagePlaceKey,
} from './message-child-stream.ts';

const { id, position, nullableInstant } = teamsFields;

const properties = {
  ...messageKey,
  emojiPosition: {
    ...position,
    description: 'The emoji’s place among the message’s reactions, from 0.',
  },
  userPosition: {
    ...position,
    description: 'The user’s place among those who reacted so, from 0.',
  },
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
  readonly primaryKey = [...messagePlaceKey, 'emojiPosition', 'userPosition'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per person’s reaction to a message. Primary key accountId, store, conversationId, recordId, entry (its message’s place), emojiPosition and userPosition. A reaction taken back from a message the app still holds is deleted; reactions of a message the app dropped from its cache stay.',
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
