import type { RecordDraft } from '@workspace/elt';
import {
  type Message,
  type ReactionCount,
  ReceiptInfo,
} from '@workspace/sdk-whatsapp-desktop';

import type { OnMessage } from '../chat-storage-records.ts';
import {
  messageKeyColumns,
  messageKeyFields,
  messageKeyRecord,
} from '../message-key-fields.ts';
import { WhatsAppMessageStream } from '../whatsapp-message-stream.ts';
import { whatsappFields } from '../whatsapp-stream.ts';

const { text, integer } = whatsappFields;

const properties = {
  ...messageKeyFields,
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
  readonly primaryKey = [...messageKeyColumns, 'emoji'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per emoji people reacted with to a channel post, which WhatsApp counts rather than naming who reacted; decoded from the post’s receipt info. Primary key chatJid, messageIsFromMe, messageStanzaId, emoji.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected *messageRows(
    message: Message,
  ): Generator<OnMessage<ReactionCount>> {
    if (message.receiptInfo !== null)
      for (const item of new ReceiptInfo(message.receiptInfo).reactionCounts)
        yield { message, item };
  }

  protected record({
    message,
    item,
  }: OnMessage<ReactionCount>): RecordDraft<typeof properties> {
    return { ...messageKeyRecord(message), ...item };
  }
}
