import type { RecordDraft } from '@workspace/elt';
import type {
  TeamsMessage,
  TeamsMessageLink,
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
    description: 'The link’s place among the message’s links, from 0.',
  },
  url: { ...id, description: 'The address.' },
  title: { ...nullableText, description: 'The title of its preview.' },
  description: {
    ...nullableText,
    description: 'The description of its preview.',
  },
  previewUrl: {
    ...nullableText,
    description: 'The image of its preview.',
  },
} as const;

export class MessageLinksStream extends MessageChildStream<
  typeof properties,
  TeamsMessageLink
> {
  readonly name = 'messageLinks';
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
      'One record per link Teams found in a message, with the preview it shows. Primary key accountId, conversationId, threadId, messageId, position. A link edited out of a message the app still holds is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected children({ links }: TeamsMessage): readonly TeamsMessageLink[] {
    return links;
  }

  protected records({
    key,
    child: link,
  }: Part<TeamsMessageLink>): RecordDraft<typeof properties>[] {
    return [{ ...key, ...link }];
  }
}
