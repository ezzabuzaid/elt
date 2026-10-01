import type { SchemaRecord } from 'elt';
import type { BooksScan } from '../books-scan.ts';
import { BooksStream, booksFields } from '../books-stream.ts';
import {
  coreDataTime,
  flag,
  integer,
  nullableFlag,
  number,
  type Row,
  text,
} from '../books-values.ts';

const {
  boolean,
  nullableBoolean,
  nullableInteger,
  nullableNumber,
  nullableText,
  nullableTimestamp,
} = booksFields;

const properties = {
  assetId: {
    ...booksFields.assetId,
    description:
      'The book; refers to libraryAssets.assetId when the book is in the library on this Mac. Books on other devices only appear here.',
  },
  deleted: {
    ...boolean,
    description: 'Deleted, kept until the deletion syncs.',
  },
  readingProgress: {
    ...nullableNumber,
    minimum: 0,
    maximum: 1,
    description: 'Fraction of the book read at the synced position, 0 to 1.',
  },
  highWaterMarkProgress: {
    ...nullableNumber,
    minimum: 0,
    maximum: 1,
    description: 'Furthest fraction of the book ever reached, 0 to 1.',
  },
  isFinished: { ...boolean, description: 'Marked as finished.' },
  notFinished: {
    ...nullableBoolean,
    description: 'Marked as still reading; NULL when unset.',
  },
  finishedDateKind: {
    ...nullableInteger,
    description: 'How Books recorded the finished date.',
  },
  finishedAt: { ...nullableTimestamp, description: 'When it was finished.' },
  isTrackedAsRecent: {
    ...nullableBoolean,
    description: 'Listed among recent books.',
  },
  lastOpenedAt: { ...nullableTimestamp, description: 'When last opened.' },
  lastEngagedAt: {
    ...nullableTimestamp,
    description: 'When the user last engaged with it.',
  },
  modifiedAt: {
    ...nullableTimestamp,
    description: 'When this record last changed.',
  },
  starRating: {
    ...nullableInteger,
    description: 'Star rating the user gave, 0 when none.',
  },
  taste: {
    ...nullableInteger,
    description: 'Suggest more or less like this, as Books records it.',
  },
  tasteSyncedToStore: {
    ...nullableBoolean,
    description: 'Whether the taste was sent to the store.',
  },
  audiobookPosition: {
    ...nullableNumber,
    description: 'Playback position in seconds, for audiobooks.',
  },
  audiobookPositionUpdatedAt: {
    ...nullableTimestamp,
    description: 'When the playback position last changed.',
  },
  position: {
    ...nullableText,
    description: 'Synced reading position as an EPUB CFI (epubcfi(...)).',
  },
  positionRangeStart: {
    ...nullableInteger,
    description: 'Start offset of the position within its chapter.',
  },
  positionRangeEnd: {
    ...nullableInteger,
    description: 'End offset of the position within its chapter.',
  },
  positionPhysicalLocation: {
    ...nullableInteger,
    description: 'Absolute position, for fixed-layout and PDF books.',
  },
  positionStorageId: {
    ...nullableText,
    description: 'Books storage identifier of the chapter at the position.',
  },
  positionAssetVersion: {
    ...nullableText,
    description: 'Book version the position refers to.',
  },
  positionAnnotationVersion: {
    ...nullableText,
    description: 'Annotation format version of the position.',
  },
  positionUpdatedAt: {
    ...nullableTimestamp,
    description: 'When the position last moved.',
  },
} as const;

export class AssetDetailsStream extends BooksStream<typeof properties, Row> {
  readonly name = 'assetDetails';
  readonly store = 'assetData';
  readonly primaryKey = ['assetId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      "One source record per book with reading state that Books syncs through iCloud: progress, finished state, rating and position. Covers books read on other devices that are not in this Mac's library. Relationships name streams in this source, not physical destination tables.",
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: BooksScan): readonly Row[] {
    return scan.assetData.all(
      'SELECT * FROM ZBCASSETDETAIL WHERE ZASSETID IS NOT NULL ORDER BY Z_PK',
    );
  }

  protected record(row: Row): SchemaRecord<typeof properties> {
    return {
      assetId: row.ZASSETID as string,
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
    };
  }
}
