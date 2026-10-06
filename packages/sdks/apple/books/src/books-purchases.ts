import { AppDatabase } from '@workspace/sdk-apple-app-database';

import { coreDataTime, integer, nullableFlag, text } from './books-values.ts';
import { BooksSchemaError, BooksUnavailableError } from './errors.ts';

// The Jalisco columns this reader reads; opening the store checks them.
const purchasesColumns = {
  ZBLJALISCOSERVERITEM: [
    'ZSTOREID',
    'ZTITLE',
    'ZSORTEDTITLE',
    'ZARTIST',
    'ZSORTEDAUTHOR',
    'ZGENRE',
    'ZFILEEXTENSION',
    'ZDISPLAYVERSION',
    'ZPURCHASEDAT',
    'ZEXPECTEDDATE',
    'ZISAUDIOBOOK',
    'ZCONTAINSAUDIO',
    'ZISEXPLICIT',
    'ZISHIDDEN',
    'ZISDISABLED',
    'ZISPICTUREBOOK',
    'ZISREADALOUD',
    'ZPURCHASEHISTORYID',
    'ZSTOREACCOUNTID',
    'ZARTWORKURLSTRING',
  ],
} as const;

// An item the Apple Account bought from the Book Store, as Books last fetched
// the purchase history.
export type Purchase = {
  readonly storeId: string;
  readonly title: string | null;
  readonly sortTitle: string | null;
  readonly artist: string | null;
  readonly sortAuthor: string | null;
  readonly genre: string | null;
  readonly fileExtension: string | null;
  readonly version: string | null;
  readonly purchasedAt: Date | null;
  readonly expectedAt: Date | null;
  readonly isAudiobook: boolean | null;
  readonly containsAudio: boolean | null;
  readonly isExplicit: boolean | null;
  readonly isHidden: boolean | null;
  readonly isDisabled: boolean | null;
  readonly isPictureBook: boolean | null;
  readonly isReadAloud: boolean | null;
  readonly purchaseHistoryId: number | null;
  readonly storeAccountId: number | null;
  readonly artworkUrl: string | null;
};

// BKJaliscoServerSource as Books last saved it, pinned to one moment.
export class BooksPurchases implements Disposable {
  readonly #database: AppDatabase;

  constructor(path: string) {
    this.#database = new AppDatabase(path, BooksUnavailableError);
    this.#database.requireColumns(purchasesColumns, BooksSchemaError);
  }

  purchases(): Purchase[] {
    return this.#database
      .all(
        'SELECT * FROM ZBLJALISCOSERVERITEM WHERE ZSTOREID IS NOT NULL ORDER BY Z_PK',
      )
      .map((row) => ({
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
      }));
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}
