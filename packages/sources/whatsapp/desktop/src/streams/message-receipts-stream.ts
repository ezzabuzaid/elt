import type { RecordDraft } from '@eltjs/elt';
import {
  type Message,
  type Receipt,
  ReceiptInfo,
} from '@eltjs/sdk-whatsapp-desktop';

import type { OnMessage } from '../chat-storage-records.ts';
import { onMessageFields } from '../on-message-fields.ts';
import { WhatsAppMessageStream } from '../whatsapp-message-stream.ts';
import { whatsappFields } from '../whatsapp-stream.ts';

const { jid, text } = whatsappFields;
const second = { ...text, format: 'date-time', precision: 0 } as const;
const nullableSecond = { ...second, type: ['string', 'null'] } as const;

const properties = {
  ...onMessageFields,
  recipientJid: {
    ...jid,
    description:
      'A device owner the message went to: the other person, a group member, or this account itself, whose other devices also acknowledge its messages.',
  },
  deliveredAt: {
    ...nullableSecond,
    description:
      'When the recipient’s device received the message, UTC to the second; NULL until it has.',
  },
  readAt: {
    ...nullableSecond,
    description:
      'When the recipient read the message, UTC to the second; NULL until they have, or when they send no read receipts.',
  },
  playedAt: {
    ...nullableSecond,
    description:
      'When the recipient played the voice note or video, UTC to the second; NULL until they have.',
  },
} as const;

export class MessageReceiptsStream extends WhatsAppMessageStream<
  typeof properties,
  OnMessage<Receipt>
> {
  readonly name = 'messageReceipts';
  readonly primaryKey = ['messageId', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per recipient WhatsApp holds receipts from for a message, decoded from the message’s receipt info (ZWAMESSAGEINFO.ZRECEIPTINFO): WhatsApp keeps them for the messages this account sent and for some it received. Primary key messageId, position.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected *messageRows(message: Message): Generator<OnMessage<Receipt>> {
    if (message.receiptInfo !== null)
      for (const [position, item] of new ReceiptInfo(
        message.receiptInfo,
      ).receipts.entries())
        yield { message, position, item };
  }

  protected record({
    message,
    position,
    item,
  }: OnMessage<Receipt>): RecordDraft<typeof properties> {
    return { messageId: message.id, position, ...item };
  }
}
