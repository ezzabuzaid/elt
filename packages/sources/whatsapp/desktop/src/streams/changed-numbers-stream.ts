import type { RecordDraft } from '@workspace/elt';
import type { ChangedNumber } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { jid, nullableInstant } = whatsappFields;

const properties = {
  oldJid: {
    ...jid,
    description: 'The person’s old phone JID; the primary key.',
  },
  newJid: { ...jid, description: 'Their new phone JID.' },
  changedAt: {
    ...nullableInstant,
    description: 'When WhatsApp learned of the change, UTC.',
  },
} as const;

export class ChangedNumbersStream extends WhatsAppStream<
  typeof properties,
  ChangedNumber
> {
  readonly name = 'changedNumbers';
  readonly store = 'localKeyValue';
  readonly primaryKey = ['oldJid'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per person WhatsApp saw move to a new phone number (LocalKeyValue.sqlite’s changenumber-oldtonew). Primary key oldJid. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): readonly ChangedNumber[] {
    return scan.localKeyValue.changedNumbers();
  }

  protected record(change: ChangedNumber): RecordDraft<typeof properties> {
    return { ...change };
  }
}
