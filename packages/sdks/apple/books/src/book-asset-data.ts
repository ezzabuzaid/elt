import { AppDatabase } from '@workspace/sdk-apple-app-database';

import {
  coreDataTime,
  flag,
  integer,
  nullableFlag,
  number,
  stored,
  text,
} from './books-values.ts';
import { BooksSchemaError, BooksUnavailableError } from './errors.ts';

// The BCAssetData columns this reader reads; opening the store checks them.
const assetDataColumns = {
  ZBCASSETDETAIL: [
    'ZASSETID',
    'ZDELETEDFLAG',
    'ZREADINGPROGRESS',
    'ZREADINGPROGRESSHIGHWATERMARK',
    'ZISFINISHED',
    'ZNOTFINISHED',
    'ZFINISHEDDATEKIND',
    'ZDATEFINISHED',
    'ZISTRACKEDASRECENT',
    'ZLASTOPENDATE',
    'ZLASTENGAGEDDATE',
    'ZMODIFICATIONDATE',
    'ZSTARRATING',
    'ZTASTE',
    'ZTASTESYNCEDTOSTORE',
    'ZBOOKMARKTIME',
    'ZDATEPLAYBACKTIMEUPDATED',
    'ZREADINGPOSITIONCFISTRING',
    'ZREADINGPOSITIONLOCATIONRANGESTART',
    'ZREADINGPOSITIONLOCATIONRANGEEND',
    'ZREADINGPOSITIONABSOLUTEPHYSICALLOCATION',
    'ZREADINGPOSITIONSTORAGEUUID',
    'ZREADINGPOSITIONASSETVERSION',
    'ZREADINGPOSITIONANNOTATIONVERSION',
    'ZREADINGPOSITIONLOCATIONUPDATEDATE',
  ],
  ZBCASSETREVIEW: [
    'ZASSETREVIEWID',
    'ZDELETEDFLAG',
    'ZSTARRATING',
    'ZREVIEWTITLE',
    'ZREVIEWBODY',
    'ZUSERID',
    'ZMODIFICATIONDATE',
  ],
} as const;

// A book's reading state as bookdatastored syncs it across devices.
export type AssetDetail = {
  readonly assetId: string | null;
  readonly deleted: boolean;
  readonly readingProgress: number | null;
  readonly highWaterMarkProgress: number | null;
  readonly isFinished: boolean;
  readonly notFinished: boolean | null;
  readonly finishedDateKind: number | null;
  readonly finishedAt: Date | null;
  readonly isTrackedAsRecent: boolean | null;
  readonly lastOpenedAt: Date | null;
  readonly lastEngagedAt: Date | null;
  readonly modifiedAt: Date | null;
  readonly starRating: number | null;
  readonly taste: number | null;
  readonly tasteSyncedToStore: boolean | null;
  readonly audiobookPosition: number | null;
  readonly audiobookPositionUpdatedAt: Date | null;
  readonly position: string | null;
  readonly positionRangeStart: number | null;
  readonly positionRangeEnd: number | null;
  readonly positionPhysicalLocation: number | null;
  readonly positionStorageId: string | null;
  readonly positionAssetVersion: string | null;
  readonly positionAnnotationVersion: string | null;
  readonly positionUpdatedAt: Date | null;
};

export type Review = {
  readonly id: string | null;
  readonly deleted: boolean;
  readonly starRating: number | null;
  readonly title: string | null;
  readonly body: string | null;
  readonly userId: string | null;
  readonly modifiedAt: Date | null;
};

// BCAssetData as bookdatastored last saved it, pinned to one moment.
export class BookAssetData implements Disposable {
  readonly #database: AppDatabase;

  constructor(path: string) {
    this.#database = new AppDatabase(path, BooksUnavailableError);
    this.#database.requireColumns(assetDataColumns, BooksSchemaError);
  }

  details(): AssetDetail[] {
    return this.#database
      .all(
        'SELECT * FROM ZBCASSETDETAIL WHERE ZASSETID IS NOT NULL ORDER BY Z_PK',
      )
      .map((row) => ({
        assetId: stored(row.ZASSETID),
        deleted: flag(row.ZDELETEDFLAG),
        readingProgress: number(row.ZREADINGPROGRESS),
        highWaterMarkProgress: number(row.ZREADINGPROGRESSHIGHWATERMARK),
        isFinished: flag(row.ZISFINISHED),
        notFinished: nullableFlag(row.ZNOTFINISHED),
        finishedDateKind: integer(row.ZFINISHEDDATEKIND),
        finishedAt: coreDataTime(row.ZDATEFINISHED),
        isTrackedAsRecent: nullableFlag(row.ZISTRACKEDASRECENT),
        lastOpenedAt: coreDataTime(row.ZLASTOPENDATE),
        lastEngagedAt: coreDataTime(row.ZLASTENGAGEDDATE),
        modifiedAt: coreDataTime(row.ZMODIFICATIONDATE),
        starRating: integer(row.ZSTARRATING),
        taste: integer(row.ZTASTE),
        tasteSyncedToStore: nullableFlag(row.ZTASTESYNCEDTOSTORE),
        audiobookPosition: number(row.ZBOOKMARKTIME),
        audiobookPositionUpdatedAt: coreDataTime(row.ZDATEPLAYBACKTIMEUPDATED),
        position: text(row.ZREADINGPOSITIONCFISTRING),
        positionRangeStart: integer(row.ZREADINGPOSITIONLOCATIONRANGESTART),
        positionRangeEnd: integer(row.ZREADINGPOSITIONLOCATIONRANGEEND),
        positionPhysicalLocation: integer(
          row.ZREADINGPOSITIONABSOLUTEPHYSICALLOCATION,
        ),
        positionStorageId: text(row.ZREADINGPOSITIONSTORAGEUUID),
        positionAssetVersion: text(row.ZREADINGPOSITIONASSETVERSION),
        positionAnnotationVersion: text(row.ZREADINGPOSITIONANNOTATIONVERSION),
        positionUpdatedAt: coreDataTime(row.ZREADINGPOSITIONLOCATIONUPDATEDATE),
      }));
  }

  reviews(): Review[] {
    return this.#database
      .all(
        'SELECT * FROM ZBCASSETREVIEW WHERE ZASSETREVIEWID IS NOT NULL ORDER BY Z_PK',
      )
      .map((row) => ({
        id: stored(row.ZASSETREVIEWID),
        deleted: flag(row.ZDELETEDFLAG),
        starRating: integer(row.ZSTARRATING),
        title: text(row.ZREVIEWTITLE),
        body: text(row.ZREVIEWBODY),
        userId: text(row.ZUSERID),
        modifiedAt: coreDataTime(row.ZMODIFICATIONDATE),
      }));
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}
