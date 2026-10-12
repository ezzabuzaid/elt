import type { RecordDraft } from '@workspace/elt';
import type { TeamsMessage, TeamsQuote } from '@workspace/sdk-microsoft-teams';

import { teamsFields } from '../teams-stream.ts';
import {
  MessageChildStream,
  type Part,
  messageKey,
} from './message-child-stream.ts';

const { id, position, nullableText, nullableInstant } = teamsFields;

const properties = {
  ...messageKey,
  position: {
    ...position,
    description: 'The quote’s place among the message’s quotes, from 0.',
  },
  quotedMessageId: {
    ...id,
    description: 'The message it replies to (messages.id).',
  },
  quotedSenderId: {
    ...nullableText,
    description: 'Who sent the quoted message (people.mri).',
  },
  quotedSentAt: {
    ...nullableInstant,
    description: 'When the quoted message was sent.',
  },
  quotedThreadId: {
    ...nullableText,
    description: 'The quoted message’s thread, for one in a channel.',
  },
} as const;

type Quote = { readonly position: number; readonly quote: TeamsQuote };

export class MessageQuotesStream extends MessageChildStream<
  typeof properties,
  Quote
> {
  readonly name = 'messageQuotes';
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
      'One record per earlier message a message quotes in reply. Primary key accountId, conversationId, threadId, messageId, position. A quote removed from a message the app still holds is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected children({ quotes }: TeamsMessage): readonly Quote[] {
    return quotes.map((quote, position) => ({ position, quote }));
  }

  protected records({
    key,
    child: { position, quote },
  }: Part<Quote>): RecordDraft<typeof properties>[] {
    return [
      {
        ...key,
        position,
        quotedMessageId: quote.messageId,
        quotedSenderId: quote.senderId,
        quotedSentAt: quote.sentAt,
        quotedThreadId: quote.threadId,
      },
    ];
  }
}
