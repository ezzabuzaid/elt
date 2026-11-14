import type { RecordDraft, SchemaRecord } from '@eltjs/elt';
import type { Message } from '@eltjs/sdk-whatsapp-desktop';

import { WhatsAppMessageStream } from '../whatsapp-message-stream.ts';
import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { whatsappFields } from '../whatsapp-stream.ts';
import {
  messageFile,
  messageProperties,
  messageRecord,
} from './messages-stream.ts';

const properties = {
  ...messageProperties,
  copy: {
    ...whatsappFields.integer,
    minimum: 1,
    description:
      'How many earlier rows of ChatStorage hold the message: 1 for the row after the one messages loads.',
  },
} as const;

export class MessageCopiesStream extends WhatsAppMessageStream<
  typeof properties,
  Message
> {
  readonly name = 'messageCopies';
  readonly primaryKey = ['chatJid', 'isFromMe', 'stanzaId', 'copy'];
  readonly supportsFileTransfer = true;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per further row WhatsApp keeps a message on, with every column messages has, read from that row and its own media item and receipt info. WhatsApp writes a few messages a second time, on a row with its own sort, media item, receipt info and children. messages loads the first row; messageReceipts, messageReactions and messageReactionCounts are decoded from it, and this stream keeps the copy’s receipt info as stored. Primary key chatJid, isFromMe, stanzaId, copy; chatJid, isFromMe and stanzaId refer to messages.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected *messageRows(message: Message): Generator<Message> {
    if (message.copy > 0) yield message;
  }

  protected record(message: Message): RecordDraft<typeof properties> {
    return { ...messageRecord(message), copy: message.copy };
  }

  override file(
    record: SchemaRecord<typeof properties>,
    scan: WhatsAppScan,
  ): string | null {
    return messageFile(record, scan);
  }
}
