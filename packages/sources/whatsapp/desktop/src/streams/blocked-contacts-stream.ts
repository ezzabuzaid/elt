import type { RecordDraft } from '@workspace/elt';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const properties = {
  jid: {
    ...whatsappFields.jid,
    description: 'The person this account blocked (ZJID); the primary key.',
  },
} as const;

export class BlockedContactsStream extends WhatsAppStream<
  typeof properties,
  string
> {
  readonly name = 'blockedContacts';
  readonly store = 'chatStorage';
  readonly primaryKey = ['jid'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per person this account blocked on WhatsApp (ZWABLACKLISTITEM). Primary key jid. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): Iterable<string> {
    return scan.chatStorage.blockedJids;
  }

  protected record(jid: string): RecordDraft<typeof properties> {
    return { jid };
  }
}
