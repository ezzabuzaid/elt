import type { RecordDraft } from '@workspace/elt';
import {
  type Message,
  type Reaction,
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

const { text, boolean, nullableJid, nullableText } = whatsappFields;

const properties = {
  ...messageKeyFields,
  reactionStanzaId: {
    ...text,
    minLength: 1,
    description: 'The ID its sender gave the reaction.',
  },
  senderJid: {
    ...nullableJid,
    description: 'Who reacted; NULL when this account did.',
  },
  isFromMe: {
    ...boolean,
    description: 'Whether this account reacted.',
  },
  emoji: {
    ...nullableText,
    description:
      'The reaction; NULL when its sender withdrew it, which WhatsApp keeps.',
  },
  reactedAt: {
    ...text,
    format: 'date-time',
    description: 'When the reaction was sent, UTC to the millisecond.',
  },
} as const;

export class MessageReactionsStream extends WhatsAppMessageStream<
  typeof properties,
  OnMessage<Reaction>
> {
  readonly name = 'messageReactions';
  readonly primaryKey = [...messageKeyColumns, 'reactionStanzaId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per reaction to a message, decoded from the message’s receipt info (ZWAMESSAGEINFO.ZRECEIPTINFO). Primary key chatJid, messageIsFromMe, messageStanzaId, reactionStanzaId. A channel post keeps counts instead; see messageReactionCounts.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected *messageRows(message: Message): Generator<OnMessage<Reaction>> {
    if (message.receiptInfo !== null)
      for (const item of new ReceiptInfo(message.receiptInfo).reactions)
        yield { message, item };
  }

  protected record({
    message,
    item: { stanzaId, ...reaction },
  }: OnMessage<Reaction>): RecordDraft<typeof properties> {
    return {
      ...messageKeyRecord(message),
      reactionStanzaId: stanzaId,
      ...reaction,
    };
  }
}
