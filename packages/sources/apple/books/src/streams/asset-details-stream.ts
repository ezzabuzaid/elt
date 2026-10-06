import type { RecordDraft } from '@workspace/elt';
import type { AssetDetail } from '@workspace/sdk-apple-books';

import type { BooksScan } from '../books-scan.ts';
import { BooksStream, booksFields, iso } from '../books-stream.ts';

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

export class AssetDetailsStream extends BooksStream<
  typeof properties,
  AssetDetail
> {
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

  protected rows(scan: BooksScan): readonly AssetDetail[] {
    return scan.assetData.details();
  }

  protected record(detail: AssetDetail): RecordDraft<typeof properties> {
    return {
      assetId: detail.assetId,
      deleted: detail.deleted,
      readingProgress: detail.readingProgress,
      highWaterMarkProgress: detail.highWaterMarkProgress,
      isFinished: detail.isFinished,
      notFinished: detail.notFinished,
      finishedDateKind: detail.finishedDateKind,
      finishedAt: iso(detail.finishedAt),
      isTrackedAsRecent: detail.isTrackedAsRecent,
      lastOpenedAt: iso(detail.lastOpenedAt),
      lastEngagedAt: iso(detail.lastEngagedAt),
      modifiedAt: iso(detail.modifiedAt),
      starRating: detail.starRating,
      taste: detail.taste,
      tasteSyncedToStore: detail.tasteSyncedToStore,
      audiobookPosition: detail.audiobookPosition,
      audiobookPositionUpdatedAt: iso(detail.audiobookPositionUpdatedAt),
      position: detail.position,
      positionRangeStart: detail.positionRangeStart,
      positionRangeEnd: detail.positionRangeEnd,
      positionPhysicalLocation: detail.positionPhysicalLocation,
      positionStorageId: detail.positionStorageId,
      positionAssetVersion: detail.positionAssetVersion,
      positionAnnotationVersion: detail.positionAnnotationVersion,
      positionUpdatedAt: iso(detail.positionUpdatedAt),
    };
  }
}
