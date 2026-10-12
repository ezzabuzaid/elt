import type { RecordDraft } from '@workspace/elt';
import type { Receipt } from '@workspace/sdk-whatsapp-desktop';

import type { OnMessage } from '../chat-storage-records.ts';
import {
  messageKeyColumns,
  messageKeyFields,
  messageKeyRecord,
} from '../message-key-fields.ts';
import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { jid, text } = whatsappFields;
const second = { ...text, format: 'date-time', precision: 0 } as const;
const nullableSecond = { ...second, type: ['string', 'null'] } as const;

const properties = {
  ...messageKeyFields,
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

export class MessageReceiptsStream extends WhatsAppStream<
  typeof properties,
  OnMessage<Receipt>
> {
  readonly name = 'messageReceipts';
  readonly store = 'chatStorage';
  readonly primaryKey = [...messageKeyColumns, 'recipientJid'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per recipient WhatsApp holds receipts from for a message, decoded from the message’s receipt info (ZWAMESSAGEINFO.ZRECEIPTINFO): WhatsApp keeps them for the messages this account sent and for some it received. Primary key chatJid, messageIsFromMe, messageStanzaId, recipientJid.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): readonly OnMessage<Receipt>[] {
    return scan.chatStorage.receipts;
  }

  protected record({
    message,
    item,
  }: OnMessage<Receipt>): RecordDraft<typeof properties> {
    return { ...messageKeyRecord(message), ...item };
  }
}
