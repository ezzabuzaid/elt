import type { RecordDraft } from '@eltjs/elt';
import type { TeamsMention, TeamsMessage } from '@eltjs/sdk-microsoft-teams';

import { teamsFields } from '../teams-stream.ts';
import {
  MessageChildStream,
  type Part,
  messageKey,
  messagePlaceKey,
} from './message-child-stream.ts';

const { id, position, nullableText } = teamsFields;

const properties = {
  ...messageKey,
  position: {
    ...position,
    description: 'The mention’s place among the message’s mentions, from 0.',
  },
  itemId: {
    type: 'integer',
    minimum: 0,
    description:
      'The mention’s number in the message, which its content refers to as itemid.',
  },
  mentionedId: {
    ...id,
    description:
      'Who or what is mentioned: a person (people.mri), or the conversation, team or tag for everyone, channel, team and tag mentions.',
  },
  kind: {
    ...nullableText,
    description: 'person, everyone, channel, team or tag.',
  },
  displayName: {
    ...nullableText,
    description: 'The name the mention shows.',
  },
} as const;

export class MessageMentionsStream extends MessageChildStream<
  typeof properties,
  TeamsMention
> {
  readonly name = 'messageMentions';
  readonly primaryKey = [...messagePlaceKey, 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per mention in a message. Primary key accountId, store, conversationId, recordId, entry (its message’s place) and position. A mention edited out of a message the app still holds is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected children({ mentions }: TeamsMessage): readonly TeamsMention[] {
    return mentions;
  }

  protected records({
    key,
    child: mention,
  }: Part<TeamsMention>): RecordDraft<typeof properties>[] {
    return [{ ...key, ...mention }];
  }
}
