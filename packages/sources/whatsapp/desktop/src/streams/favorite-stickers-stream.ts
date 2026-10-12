import type { RecordDraft } from '@workspace/elt';
import type { FavoriteSticker } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { text, nullableInstant } = whatsappFields;

const properties = {
  fileHash: {
    ...text,
    minLength: 1,
    description: 'The sticker; refers to stickers.fileHash; the primary key.',
  },
  favoritedAt: {
    ...nullableInstant,
    description: 'When the account favorited it, UTC.',
  },
} as const;

export class FavoriteStickersStream extends WhatsAppStream<
  typeof properties,
  FavoriteSticker
> {
  readonly name = 'favoriteStickers';
  readonly store = 'backedUpKeyValue';
  readonly primaryKey = ['fileHash'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per sticker the account favorited (BackedUpKeyValue.sqlite’s fs.v2). Primary key fileHash. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): readonly FavoriteSticker[] {
    return scan.backedUpKeyValue.favoriteStickers();
  }

  protected record(sticker: FavoriteSticker): RecordDraft<typeof properties> {
    return { ...sticker };
  }
}
