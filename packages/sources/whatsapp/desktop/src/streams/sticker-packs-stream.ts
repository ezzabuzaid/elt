import type { RecordDraft } from '@workspace/elt';
import type { StickerPack } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { text, boolean, nullableText, nullableInteger } = whatsappFields;
const pack = (what: string, column: string) =>
  `${what} (ZWACDABSTRACTSTICKERPACK.${column}).`;

const properties = {
  stickerPackId: {
    ...text,
    minLength: 1,
    description: pack('The pack’s ID in WhatsApp’s catalog', 'ZSTICKERPACKID'),
  },
  inTray: {
    ...boolean,
    description:
      'Whether the record is the pack in the picker’s tray (true) or its listing in the sticker store (false); a pack can have both.',
  },
  name: { ...nullableText, description: pack('The pack’s name', 'ZNAME') },
  publisher: {
    ...nullableText,
    description: pack('Who made it', 'ZPUBLISHER'),
  },
  description: {
    ...nullableText,
    description: pack('The pack’s description', 'ZPACKDESCRIPTION'),
  },
  fileSize: {
    ...nullableInteger,
    description: pack('The pack’s size in bytes', 'ZFILESIZE'),
  },
  stickerCount: {
    ...nullableInteger,
    description: pack('How many stickers it has', 'ZSTICKERCOUNT'),
  },
  premiumStickerCount: {
    ...nullableInteger,
    description: pack('How many of them are premium', 'ZPREMIUMSTICKERCOUNT'),
  },
  order: {
    ...nullableInteger,
    description: pack('Its place in the tray or the store’s list', 'ZORDER'),
  },
  flags: {
    ...nullableInteger,
    description:
      'WhatsApp’s undocumented bit flags of the pack, which differ between the tray (ZFLAGS) and the store (ZFLAGS1, where 2 is animated, 1 and 4 Lottie and 8 premium).',
  },
  imageDataHash: {
    ...nullableText,
    description: pack(
      'The catalog’s hash of the pack’s images',
      'ZIMAGEDATAHASH',
    ),
  },
  trayImageId: {
    ...nullableText,
    description: pack('The tray icon’s ID', 'ZTRAYIMAGEID'),
  },
  trayImageFilePath: {
    ...nullableText,
    description: pack(
      'Where WhatsApp keeps the tray icon, relative to its stickers folder',
      'ZTRAYIMAGEFILEPATH',
    ),
  },
  previewImageIds: {
    type: 'array',
    items: text,
    description: pack('The store’s preview images, by ID', 'ZPREVIEWIMAGEIDS'),
  },
} as const;

export class StickerPacksStream extends WhatsAppStream<
  typeof properties,
  StickerPack
> {
  readonly name = 'stickerPacks';
  readonly store = 'stickers';
  readonly primaryKey = ['stickerPackId', 'inTray'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per sticker pack in the picker’s tray, and one per pack in the copy WhatsApp keeps of its sticker store’s catalog (Sticker.sqlite). Primary key stickerPackId, inTray. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): Iterable<StickerPack> {
    return scan.stickers.packs();
  }

  protected record(pack: StickerPack): RecordDraft<typeof properties> {
    return { ...pack, previewImageIds: [...pack.previewImageIds] };
  }
}
