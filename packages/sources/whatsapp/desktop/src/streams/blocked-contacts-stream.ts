import type { RecordDraft } from '@eltjs/elt';
import type { BlockedContact } from '@eltjs/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, rowId, whatsappFields } from '../whatsapp-stream.ts';

const properties = {
  id: rowId('ZWABLACKLISTITEM'),
  jid: {
    ...whatsappFields.jid,
    description: 'The person this account blocked (ZJID).',
  },
} as const;

export class BlockedContactsStream extends WhatsAppStream<
  typeof properties,
  BlockedContact
> {
  readonly name = 'blockedContacts';
  readonly store = 'chatStorage';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per person this account blocked on WhatsApp (ZWABLACKLISTITEM). Primary key id. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): Iterable<BlockedContact> {
    return scan.chatStorage.blockedContacts;
  }

  protected record(blocked: BlockedContact): RecordDraft<typeof properties> {
    return { ...blocked };
  }
}
