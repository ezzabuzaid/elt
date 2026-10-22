import type { RecordDraft } from '@workspace/elt';
import type { DisappearingMode } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { jid, integer, nullableText } = whatsappFields;

const properties = {
  lid: {
    ...jid,
    description: 'The account, by LID; refers to users.lid; the primary key.',
  },
  durationSeconds: {
    ...integer,
    minimum: 0,
    description:
      'The account’s default timer for messages in new chats, in seconds: 0 off, 86400 a day, 604800 a week, 7776000 ninety days.',
  },
  setAt: {
    ...nullableText,
    format: 'date-time',
    precision: 0,
    description:
      'When the account set it, UTC; NULL when WhatsApp has no time.',
  },
} as const;

export class DisappearingModesStream extends WhatsAppStream<
  typeof properties,
  DisappearingMode
> {
  readonly name = 'disappearingModes';
  readonly store = 'localKeyValue';
  readonly primaryKey = ['lid'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per account whose default disappearing-message timer WhatsApp knows, this account’s own among them (LocalKeyValue.sqlite’s disappearing-mode). Primary key lid. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): Iterable<DisappearingMode> {
    return scan.localKeyValue.disappearingModes();
  }

  protected record(mode: DisappearingMode): RecordDraft<typeof properties> {
    return { ...mode };
  }
}
