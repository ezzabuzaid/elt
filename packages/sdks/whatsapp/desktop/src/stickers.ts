import { join } from 'node:path';

import { decodeArchive } from '@workspace/codec-plist';
import {
  AppDatabase,
  type AppDatabaseColumns,
} from '@workspace/sdk-apple-app-database';

import { WhatsAppSchemaError, WhatsAppUnavailableError } from './errors.ts';
import { bytes, number, onDisk, requiredText, text } from './values.ts';

// A sticker pack: one in the tray of the account's sticker picker, or one
// WhatsApp's sticker store lists, which WhatsApp keeps a copy of its catalog
// as (Sticker.sqlite's WACDStickerPack and WACDStoreStickerPack).
export type StickerPack = {
  readonly stickerPackId: string;
  readonly inTray: boolean;
  readonly name: string | null;
  readonly publisher: string | null;
  readonly description: string | null;
  readonly fileSize: number | null;
  readonly stickerCount: number | null;
  readonly premiumStickerCount: number | null;
  readonly order: number | null;
  readonly flags: number | null;
  readonly imageDataHash: string | null;
  readonly trayImageId: string | null;
  readonly trayImageFilePath: string | null;
  readonly previewImageIds: readonly string[];
};

// A sticker WhatsApp keeps: one of a tray pack's, or one the account
// favorited or sent, which belongs to no pack.
export type Sticker = {
  readonly fileHash: string;
  readonly stickerPackId: string | null;
  readonly sort: number | null;
  readonly mimeType: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly fileLength: number | null;
  readonly flags: number | null;
  readonly emojis: string | null;
  readonly accessibilityText: string | null;
  readonly imageHash: string | null;
  readonly relativeImagePath: string | null;
  // relativeImagePath on disk, when the file is there.
  readonly file: string | null;
};

// Left out: the media keys, encrypted hashes and server paths WhatsApp
// downloads stickers by, and the salted hashes it derives on this Mac.
const requiredColumns = {
  ZWACDABSTRACTSTICKERPACK: [
    'Z_PK',
    'Z_ENT',
    'ZSTICKERPACKID',
    'ZNAME',
    'ZPUBLISHER',
    'ZPACKDESCRIPTION',
    'ZFILESIZE',
    'ZSTICKERCOUNT',
    'ZPREMIUMSTICKERCOUNT',
    'ZORDER',
    'ZFLAGS',
    'ZFLAGS1',
    'ZIMAGEDATAHASH',
    'ZTRAYIMAGEID',
    'ZTRAYIMAGEFILEPATH',
    'ZPREVIEWIMAGEIDS',
  ],
  ZWACDSTICKER: [
    'Z_PK',
    'ZFILEHASH',
    'ZSTICKERPACK',
    'ZSORT',
    'ZMIMETYPE',
    'ZWIDTH',
    'ZHEIGHT',
    'ZFILELENGTH',
    'ZFLAGS',
    'ZEMOJIS',
    'ZACCESSIBILITYTEXT',
    'ZIMAGEHASH',
    'ZRELATIVEIMAGEPATH',
  ],
  Z_PRIMARYKEY: ['Z_ENT', 'Z_NAME'],
} satisfies AppDatabaseColumns;

// Where WhatsApp keeps a sticker's or tray image's file, from its path.
export function stickerFile(container: string, relativePath: string): string {
  return join(container, 'stickers', relativePath);
}

// Sticker.sqlite as of one moment.
export class StickersSnapshot implements Disposable {
  readonly #database: AppDatabase;
  readonly #container: string;
  readonly #tray: number;
  readonly #store: number;

  constructor(path: string, container: string) {
    this.#container = container;
    this.#database = new AppDatabase(path, WhatsAppUnavailableError);
    this.#database.requireColumns(requiredColumns, WhatsAppSchemaError);
    try {
      this.#tray = this.#entity('WACDStickerPack');
      this.#store = this.#entity('WACDStoreStickerPack');
    } catch (error) {
      this.#database[Symbol.dispose]();
      throw error;
    }
  }

  packs(): StickerPack[] {
    return this.#database
      .all(
        `SELECT Z_ENT AS entity, ZSTICKERPACKID AS stickerPackId, ZNAME AS name,
                ZPUBLISHER AS publisher, ZPACKDESCRIPTION AS description,
                ZFILESIZE AS fileSize, ZSTICKERCOUNT AS stickerCount,
                ZPREMIUMSTICKERCOUNT AS premiumStickerCount, ZORDER AS "order",
                ZFLAGS AS trayFlags, ZFLAGS1 AS storeFlags,
                ZIMAGEDATAHASH AS imageDataHash, ZTRAYIMAGEID AS trayImageId,
                ZTRAYIMAGEFILEPATH AS trayImageFilePath,
                ZPREVIEWIMAGEIDS AS previewImageIds
         FROM ZWACDABSTRACTSTICKERPACK WHERE Z_ENT IN (?, ?) ORDER BY Z_PK`,
        this.#tray,
        this.#store,
      )
      .map((row) => {
        const inTray = Number(row.entity) === this.#tray;
        return {
          stickerPackId: requiredText(
            row.stickerPackId,
            'A WhatsApp sticker pack has no ID',
          ),
          inTray,
          name: text(row.name),
          publisher: text(row.publisher),
          description: text(row.description),
          fileSize: number(row.fileSize),
          stickerCount: number(row.stickerCount),
          premiumStickerCount: number(row.premiumStickerCount),
          order: number(row.order),
          // Core Data stores each subentity's own flags attribute in its own
          // column.
          flags: number(inTray ? row.trayFlags : row.storeFlags),
          imageDataHash: text(row.imageDataHash),
          trayImageId: text(row.trayImageId),
          trayImageFilePath: text(row.trayImageFilePath),
          previewImageIds: previewImageIds(row.previewImageIds),
        };
      });
  }

  stickers(): Sticker[] {
    return this.#database
      .all(
        `SELECT sticker.ZFILEHASH AS fileHash,
                pack.ZSTICKERPACKID AS stickerPackId, sticker.ZSORT AS sort,
                sticker.ZMIMETYPE AS mimeType, sticker.ZWIDTH AS width,
                sticker.ZHEIGHT AS height, sticker.ZFILELENGTH AS fileLength,
                sticker.ZFLAGS AS flags, sticker.ZEMOJIS AS emojis,
                sticker.ZACCESSIBILITYTEXT AS accessibilityText,
                sticker.ZIMAGEHASH AS imageHash,
                sticker.ZRELATIVEIMAGEPATH AS relativeImagePath
         FROM ZWACDSTICKER AS sticker
         LEFT JOIN ZWACDABSTRACTSTICKERPACK AS pack
           ON pack.Z_PK = sticker.ZSTICKERPACK
         ORDER BY sticker.Z_PK`,
      )
      .map((row) => {
        const relativeImagePath = text(row.relativeImagePath);
        return {
          fileHash: requiredText(
            row.fileHash,
            'A WhatsApp sticker has no hash',
          ),
          stickerPackId: text(row.stickerPackId),
          sort: number(row.sort),
          mimeType: text(row.mimeType),
          width: number(row.width),
          height: number(row.height),
          fileLength: number(row.fileLength),
          flags: number(row.flags),
          emojis: text(row.emojis),
          accessibilityText: text(row.accessibilityText),
          imageHash: text(row.imageHash),
          relativeImagePath,
          file:
            relativeImagePath === null
              ? null
              : onDisk(stickerFile(this.#container, relativeImagePath)),
        };
      });
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }

  // A subentity's number, which changes between model versions.
  #entity(name: string): number {
    const [row] = this.#database.all(
      'SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = ?',
      name,
    );
    if (row === undefined)
      throw new WhatsAppSchemaError(this.#database.path, [
        `Z_PRIMARYKEY.${name}`,
      ]);
    return Number(row.Z_ENT);
  }
}

function previewImageIds(value: unknown): string[] {
  const archive = bytes(value);
  if (archive === null) return [];
  const ids = decodeArchive(archive);
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string'))
    throw new TypeError('WhatsApp sticker previews are not a list of IDs');
  return ids;
}
