import type { SchemaRecord } from 'elt';
import type { BooksScan } from '../books-scan.ts';
import { BooksStream, booksFields } from '../books-stream.ts';
import {
  coreDataTime,
  integer,
  nullableFlag,
  type Row,
  text,
} from '../books-values.ts';

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

export class PurchasesStream extends BooksStream<typeof properties, Row> {
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

  protected rows(scan: BooksScan): readonly Row[] {
    return scan.purchases.all(
      'SELECT * FROM ZBLJALISCOSERVERITEM WHERE ZSTOREID IS NOT NULL ORDER BY Z_PK',
    );
  }

  protected record(row: Row): SchemaRecord<typeof properties> {
    return {
      storeId: String(row.ZSTOREID),
      title: text(row.ZTITLE),
      sortTitle: text(row.ZSORTEDTITLE),
      artist: text(row.ZARTIST),
      sortAuthor: text(row.ZSORTEDAUTHOR),
      genre: text(row.ZGENRE),
      fileExtension: text(row.ZFILEEXTENSION),
      version: text(row.ZDISPLAYVERSION),
      purchasedAt: coreDataTime(row.ZPURCHASEDAT),
      expectedAt: coreDataTime(row.ZEXPECTEDDATE),
      isAudiobook: nullableFlag(row.ZISAUDIOBOOK),
      containsAudio: nullableFlag(row.ZCONTAINSAUDIO),
      isExplicit: nullableFlag(row.ZISEXPLICIT),
      isHidden: nullableFlag(row.ZISHIDDEN),
      isDisabled: nullableFlag(row.ZISDISABLED),
      isPictureBook: nullableFlag(row.ZISPICTUREBOOK),
      isReadAloud: nullableFlag(row.ZISREADALOUD),
      purchaseHistoryId: integer(row.ZPURCHASEHISTORYID),
      storeAccountId: integer(row.ZSTOREACCOUNTID),
      artworkUrl: text(row.ZARTWORKURLSTRING),
    };
  }
}
