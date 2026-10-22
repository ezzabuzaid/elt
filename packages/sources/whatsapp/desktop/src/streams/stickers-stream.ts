import type { RecordDraft, SchemaRecord } from '@workspace/elt';
import { type Sticker, stickerFile } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { text, boolean, nullableText, nullableInteger } = whatsappFields;
const sticker = (what: string, column: string) =>
  `${what} (ZWACDSTICKER.${column}).`;

const properties = {
  fileHash: {
    ...text,
    minLength: 1,
    description: sticker(
      'The SHA-256 of the sticker file as WhatsApp’s servers hold it, base64; the primary key',
      'ZFILEHASH',
    ),
  },
  stickerPackId: {
    ...nullableText,
    description:
      'The tray pack it belongs to; refers to stickerPacks; NULL for a sticker the account favorited or sent, which belongs to no pack.',
  },
  sort: {
    ...nullableInteger,
    description: sticker('Its place in its pack', 'ZSORT'),
  },
  mimeType: {
    ...nullableText,
    description: sticker(
      'image/webp, or application/was for an animated WhatsApp sticker',
      'ZMIMETYPE',
    ),
  },
  width: {
    ...nullableInteger,
    description: sticker('Width in pixels', 'ZWIDTH'),
  },
  height: {
    ...nullableInteger,
    description: sticker('Height in pixels', 'ZHEIGHT'),
  },
  fileLength: {
    ...nullableInteger,
    description: sticker(
      'The file’s size in bytes on WhatsApp’s servers',
      'ZFILELENGTH',
    ),
  },
  flags: {
    ...nullableInteger,
    description: sticker(
      'WhatsApp’s undocumented bit flags; bit 1 is animated',
      'ZFLAGS',
    ),
  },
  emojis: {
    ...nullableText,
    description: sticker(
      'The emoji it stands for, separated by spaces',
      'ZEMOJIS',
    ),
  },
  accessibilityText: {
    ...nullableText,
    description: sticker(
      'Its description for screen readers',
      'ZACCESSIBILITYTEXT',
    ),
  },
  imageHash: {
    ...nullableText,
    description: sticker('WhatsApp’s hash of the image', 'ZIMAGEHASH'),
  },
  relativeImagePath: {
    ...nullableText,
    description: sticker(
      'Where WhatsApp keeps the file, relative to its stickers folder',
      'ZRELATIVEIMAGEPATH',
    ),
  },
  availableLocally: {
    ...boolean,
    description:
      'Whether the file at relativeImagePath was on this Mac when the record was read. File bytes are exported only when true.',
  },
} as const;

export class StickersStream extends WhatsAppStream<typeof properties, Sticker> {
  readonly name = 'stickers';
  readonly store = 'stickers';
  readonly primaryKey = ['fileHash'];
  readonly supportsFileTransfer = true;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per sticker WhatsApp keeps: those of the tray’s packs, and those the account favorited or sent (see favoriteStickers and recentStickers). Primary key fileHash. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): Iterable<Sticker> {
    return scan.stickers.stickers();
  }

  protected record({ file, ...row }: Sticker): RecordDraft<typeof properties> {
    return { ...row, availableLocally: file !== null };
  }

  override file(
    { relativeImagePath, availableLocally }: SchemaRecord<typeof properties>,
    scan: WhatsAppScan,
  ): string | null {
    return availableLocally && relativeImagePath !== null
      ? stickerFile(scan.container, relativeImagePath)
      : null;
  }
}
