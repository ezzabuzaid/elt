import type { RecordDraft } from '@workspace/elt';
import type { Purchase } from '@workspace/sdk-apple-books';

import type { BooksScan } from '../books-scan.ts';
import { BooksStream, booksFields, iso } from '../books-stream.ts';

const { nullableBoolean, nullableInteger, nullableText, nullableTimestamp } =
  booksFields;

const properties = {
  storeId: {
    ...booksFields.id,
    description:
      'Apple Books store item ID; refers to libraryAssets.storeId when the purchase is in the library on this Mac.',
  },
  title: { ...nullableText, description: 'Title.' },
  sortTitle: { ...nullableText, description: 'Title the store sorts by.' },
  artist: { ...nullableText, description: 'Author or narrator.' },
  sortAuthor: { ...nullableText, description: 'Author the store sorts by.' },
  genre: { ...nullableText, description: 'Genre.' },
  fileExtension: {
    ...nullableText,
    description: 'Extension of the downloadable file, such as epub or m4b.',
  },
  version: { ...nullableText, description: 'Store version as displayed.' },
  purchasedAt: { ...nullableTimestamp, description: 'When it was bought.' },
  expectedAt: {
    ...nullableTimestamp,
    description: 'Expected release, for preorders.',
  },
  isAudiobook: { ...nullableBoolean, description: 'An audiobook.' },
  containsAudio: { ...nullableBoolean, description: 'Contains audio.' },
  isExplicit: { ...nullableBoolean, description: 'Marked explicit.' },
  isHidden: {
    ...nullableBoolean,
    description: 'Hidden from the purchased list.',
  },
  isDisabled: {
    ...nullableBoolean,
    description: 'No longer available to download.',
  },
  isPictureBook: { ...nullableBoolean, description: 'A picture book.' },
  isReadAloud: {
    ...nullableBoolean,
    description: 'Has read-aloud narration.',
  },
  purchaseHistoryId: {
    ...nullableInteger,
    description: 'Store purchase history identifier.',
  },
  storeAccountId: {
    ...nullableInteger,
    description: 'Store account that bought it.',
  },
  artworkUrl: {
    ...nullableText,
    description: 'Store artwork URL template.',
  },
} as const;

export class PurchasesStream extends BooksStream<typeof properties, Purchase> {
  readonly name = 'purchases';
  readonly store = 'purchases';
  readonly primaryKey = ['storeId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per book or audiobook the Apple Account bought in the Books store, downloaded or not. Download tokens and DRM parameters are left out. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: BooksScan): readonly Purchase[] {
    return scan.purchases.purchases();
  }

  protected record(purchase: Purchase): RecordDraft<typeof properties> {
    return {
      storeId: purchase.storeId,
      title: purchase.title,
      sortTitle: purchase.sortTitle,
      artist: purchase.artist,
      sortAuthor: purchase.sortAuthor,
      genre: purchase.genre,
      fileExtension: purchase.fileExtension,
      version: purchase.version,
      purchasedAt: iso(purchase.purchasedAt),
      expectedAt: iso(purchase.expectedAt),
      isAudiobook: purchase.isAudiobook,
      containsAudio: purchase.containsAudio,
      isExplicit: purchase.isExplicit,
      isHidden: purchase.isHidden,
      isDisabled: purchase.isDisabled,
      isPictureBook: purchase.isPictureBook,
      isReadAloud: purchase.isReadAloud,
      purchaseHistoryId: purchase.purchaseHistoryId,
      storeAccountId: purchase.storeAccountId,
      artworkUrl: purchase.artworkUrl,
    };
  }
}
