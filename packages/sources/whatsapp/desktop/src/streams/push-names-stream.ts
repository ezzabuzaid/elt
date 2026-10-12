import type { RecordDraft } from '@workspace/elt';
import type { PushName } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { jid, nullableText } = whatsappFields;

const properties = {
  jid: { ...jid, description: 'The person (ZJID); the primary key.' },
  pushName: {
    ...nullableText,
    description:
      'The name the person gave WhatsApp, which it shows beside their number when they are not in the address book (ZPUSHNAME).',
  },
} as const;

export class PushNamesStream extends WhatsAppStream<
  typeof properties,
  PushName
> {
  readonly name = 'pushNames';
  readonly store = 'chatStorage';
  readonly primaryKey = ['jid'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per person whose own WhatsApp name this account has seen (ZWAPROFILEPUSHNAME). Primary key jid. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): readonly PushName[] {
    return scan.chatStorage.pushNames;
  }

  protected record(name: PushName): RecordDraft<typeof properties> {
    return { ...name };
  }
}
