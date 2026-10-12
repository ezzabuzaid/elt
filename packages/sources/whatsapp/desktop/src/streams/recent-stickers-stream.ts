import type { RecordDraft } from '@workspace/elt';
import type { RecentSticker } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { text, integer, nullableInteger, nullableNumber } = whatsappFields;

const properties = {
  fileHash: {
    ...text,
    minLength: 1,
    description: 'The sticker; refers to stickers.fileHash; the primary key.',
  },
  position: {
    ...integer,
    minimum: 0,
    description: 'Its place in the picker’s recent list, by score.',
  },
  score: {
    ...nullableNumber,
    description: 'WhatsApp’s ranking score for it.',
  },
  lastUsed: {
    ...nullableInteger,
    description:
      'When the account last sent it, in Unix milliseconds; 0 or 1 where WhatsApp keeps no time.',
  },
} as const;

export class RecentStickersStream extends WhatsAppStream<
  typeof properties,
  RecentSticker
> {
  readonly name = 'recentStickers';
  readonly store = 'backedUpKeyValue';
  readonly primaryKey = ['fileHash'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per sticker in the picker’s recent list (BackedUpKeyValue.sqlite’s rs.v2). Primary key fileHash. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): readonly RecentSticker[] {
    return scan.backedUpKeyValue.recentStickers();
  }

  protected record(sticker: RecentSticker): RecordDraft<typeof properties> {
    return { ...sticker };
  }
}
