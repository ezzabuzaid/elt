import type { RecordDraft } from '@workspace/elt';
import type {
  TeamsMention,
  TeamsMessage,
} from '@workspace/sdk-microsoft-teams';

import { teamsFields } from '../teams-stream.ts';
import {
  MessageChildStream,
  type Part,
  messageKey,
} from './message-child-stream.ts';

const { id, position, nullableText } = teamsFields;

const properties = {
  ...messageKey,
  position: {
    ...position,
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
  readonly primaryKey = [
    'accountId',
    'conversationId',
    'threadId',
    'messageId',
    'position',
  ];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per mention in a message. Primary key accountId, conversationId, threadId, messageId, position. A mention edited out of a message the app still holds is deleted.',
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
