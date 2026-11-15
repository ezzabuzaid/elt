import type { RecordDraft } from '@eltjs/elt';
import {
  type Message,
  type ReactionCount,
  ReceiptInfo,
} from '@eltjs/sdk-whatsapp-desktop';

import type { OnMessage } from '../chat-storage-records.ts';
import { onMessageFields } from '../on-message-fields.ts';
import { WhatsAppMessageStream } from '../whatsapp-message-stream.ts';
import { whatsappFields } from '../whatsapp-stream.ts';

const { text, integer } = whatsappFields;

const properties = {
  ...onMessageFields,
  emoji: { ...text, minLength: 1, description: 'The reaction.' },
  count: {
    ...integer,
    minimum: 0,
    description: 'How many people reacted with it.',
  },
} as const;

export class MessageReactionCountsStream extends WhatsAppMessageStream<
  typeof properties,
  OnMessage<ReactionCount>
> {
  readonly name = 'messageReactionCounts';
  readonly primaryKey = ['messageId', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per emoji people reacted with to a channel post, which WhatsApp counts rather than naming who reacted; decoded from the post’s receipt info. Primary key messageId, position.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected *messageRows(
    message: Message,
  ): Generator<OnMessage<ReactionCount>> {
    if (message.receiptInfo !== null)
      for (const [position, item] of new ReceiptInfo(
        message.receiptInfo,
      ).reactionCounts.entries())
        yield { message, position, item };
  }

  protected record({
    message,
    position,
    item,
  }: OnMessage<ReactionCount>): RecordDraft<typeof properties> {
    return { messageId: message.id, position, ...item };
  }
}
