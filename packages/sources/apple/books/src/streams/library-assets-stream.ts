import type { RecordDraft } from '@workspace/elt';
import { type LibraryAsset, contentTypes } from '@workspace/sdk-apple-books';

import type { BooksScan } from '../books-scan.ts';
import { BooksStream, base64, booksFields, iso } from '../books-stream.ts';

const {
  boolean,
  nullableBoolean,
  nullableInteger,
  nullableNumber,
  nullableText,
  nullableTimestamp,
} = booksFields;

const properties = {
  assetId: booksFields.assetId,
  title: { ...nullableText, description: 'Title.' },
  sortTitle: { ...nullableText, description: 'Title Books sorts by.' },
  author: { ...nullableText, description: 'Author as displayed.' },
  sortAuthor: { ...nullableText, description: 'Author Books sorts by.' },
  authorCount: { ...nullableInteger, description: 'Number of authors.' },
  authorNames: {
    ...nullableText,
    description:
      'Author names as Books archives them, base64-encoded; NULL when not recorded.',
  },
  narratorCount: {
    ...nullableInteger,
    description: 'Number of narrators, for audiobooks.',
  },
  narratorNames: {
    ...nullableText,
    description:
      'Narrator names as Books archives them, base64-encoded; NULL when not recorded.',
  },
  genre: { ...nullableText, description: 'Primary genre.' },
  genres: {
    ...nullableText,
    description:
      'All genres as Books archives them, base64-encoded; NULL when not recorded.',
  },
  language: { ...nullableText, description: 'Language code of the book.' },
  bookDescription: {
    ...nullableText,
    description: 'Description from the book or store.',
  },
  comments: { ...nullableText, description: 'Comments from the book file.' },
  grouping: { ...nullableText, description: 'Grouping from the book file.' },
  year: { ...nullableText, description: 'Publication year as recorded.' },
  kind: { ...nullableText, description: 'Store kind of the item.' },
  contentType: {
    ...nullableText,
    enum: contentTypes,
    description:
      'What the asset is: epub or pdf; NULL for any other kind, whose code is in contentTypeCode.',
  },
  contentTypeCode: {
    ...nullableInteger,
    description: 'Books content type code behind contentType.',
  },
  mappedAssetId: {
    ...nullableText,
    description:
      'Asset this one maps to, such as the store book a sample or file matched; refers to libraryAssets.assetId.',
  },
  mappedAssetContentTypeCode: {
    ...nullableInteger,
    description: 'Content type code of the mapped asset.',
  },
  temporaryAssetId: {
    ...nullableText,
    description: 'Identifier Books used before the asset had its own.',
  },
  epubId: {
    ...nullableText,
    description: 'Unique identifier declared inside the EPUB package.',
  },
  assetGuid: { ...nullableText, description: 'Books asset GUID.' },
  storeId: {
    ...nullableText,
    description: 'Apple Books store item ID; NULL for books added from files.',
  },
  storePlaylistId: {
    ...nullableText,
    description: 'Store playlist ID, for audiobooks.',
  },
  familyId: {
    ...nullableText,
    description: 'Family Sharing member that bought the book.',
  },
  accountId: { ...nullableText, description: 'Store account ID.' },
  purchasedDsid: {
    ...nullableText,
    description: 'Store account ID that purchased the book.',
  },
  downloadedDsid: {
    ...nullableText,
    description: 'Store account ID that downloaded the book.',
  },
  dataSource: {
    ...nullableText,
    description:
      'Where Books found the asset, such as com.apple.ibooks.datasource.ubiquity for iCloud Drive.',
  },
  path: {
    ...nullableText,
    description:
      'Where the book file lives on this Mac; may be an iCloud Drive placeholder. See bookFiles.',
  },
  url: { ...nullableText, description: 'Store URL.' },
  permalink: { ...nullableText, description: 'Store permalink.' },
  coverUrl: { ...nullableText, description: 'Store cover image URL.' },
  coverAspectRatio: {
    ...nullableNumber,
    description: 'Cover width divided by height.',
  },
  coverWritingMode: {
    ...nullableText,
    description: 'Writing mode of the cover.',
  },
  pageProgressionDirection: {
    ...nullableText,
    description: 'Page turn direction declared by the book: ltr or rtl.',
  },
  pageCount: { ...nullableInteger, description: 'Number of pages.' },
  fileSize: { ...nullableInteger, description: 'File size in bytes.' },
  duration: {
    ...nullableNumber,
    description: 'Length in seconds, for audiobooks.',
  },
  readingProgress: {
    ...nullableNumber,
    minimum: 0,
    maximum: 1,
    description: 'Fraction of the book read at the current position, 0 to 1.',
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
    description:
      'Marked as still reading after being finished; NULL when unset.',
  },
  finishedDateKind: {
    ...nullableInteger,
    description: 'How Books recorded the finished date.',
  },
  finishedAt: { ...nullableTimestamp, description: 'When it was finished.' },
  lastOpenedAt: { ...nullableTimestamp, description: 'When last opened.' },
  lastEngagedAt: {
    ...nullableTimestamp,
    description: 'When the user last engaged with it.',
  },
  createdAt: {
    ...nullableTimestamp,
    description: 'When this library entry was created.',
  },
  modifiedAt: {
    ...nullableTimestamp,
    description: 'When this library entry last changed.',
  },
  purchasedAt: {
    ...nullableTimestamp,
    description:
      'When it was bought, or added to the library for books added from files.',
  },
  releasedAt: { ...nullableTimestamp, description: 'Release date.' },
  updatedAt: {
    ...nullableTimestamp,
    description: 'When the book file was last updated.',
  },
  expectedAt: {
    ...nullableTimestamp,
    description: 'Expected release, for preorders.',
  },
  rating: { ...nullableInteger, description: 'User rating.' },
  computedRating: {
    ...nullableInteger,
    description: 'Rating Books computed.',
  },
  taste: {
    ...nullableInteger,
    description: 'Suggest more or less like this, as Books records it.',
  },
  tasteSyncedToStore: {
    ...nullableBoolean,
    description: 'Whether the taste was sent to the store.',
  },
  isSample: { ...boolean, description: 'A store sample.' },
  isExplicit: { ...nullableBoolean, description: 'Marked explicit.' },
  isHidden: { ...boolean, description: 'Hidden from the library.' },
  isLocked: { ...nullableBoolean, description: 'Locked by Books.' },
  isNew: { ...nullableBoolean, description: 'Shown as new.' },
  isProof: { ...nullableBoolean, description: 'A proof copy.' },
  isDevelopment: {
    ...nullableBoolean,
    description: 'A development build of a book.',
  },
  isEphemeral: {
    ...nullableBoolean,
    description: 'Opened without being added to the library.',
  },
  isStoreAudiobook: {
    ...nullableBoolean,
    description: 'An audiobook bought from the store.',
  },
  isSupplementalContent: {
    ...nullableBoolean,
    description: 'Supplemental material of another asset.',
  },
  supplementalContentParentAssetId: {
    ...nullableText,
    description:
      'Asset this supplemental content belongs to; refers to libraryAssets.assetId.',
  },
  isTrackedAsRecent: {
    ...nullableBoolean,
    description: 'Listed among recent books.',
  },
  canRedownload: {
    ...nullableBoolean,
    description: 'Can be downloaded again from the store.',
  },
  hasReadAloudSupport: {
    ...nullableBoolean,
    description: 'Supports read-aloud.',
  },
  desktopSupportLevel: {
    ...nullableInteger,
    description: 'How well Books on Mac supports the book.',
  },
  state: {
    ...nullableInteger,
    description:
      'Books library state code. Not whether the file is on this Mac; see bookFiles.availableLocally.',
  },
  combinedState: {
    ...nullableInteger,
    description: 'Books combined library state code.',
  },
  versionNumber: { ...nullableNumber, description: 'Store version number.' },
  version: {
    ...nullableText,
    description: 'Store version as displayed.',
  },
  seriesId: { ...nullableText, description: 'Store series ID.' },
  seriesContainerAssetId: {
    ...nullableText,
    description:
      'Series this book belongs to in the library; refers to libraryAssets.assetId.',
  },
  sequenceNumber: {
    ...nullableNumber,
    description: 'Position in the series.',
  },
  sequenceDisplayName: {
    ...nullableText,
    description: 'Position in the series as displayed.',
  },
  seriesIsOrdered: {
    ...nullableBoolean,
    description: 'For a series, whether its books have an order.',
  },
  seriesIsHidden: {
    ...nullableBoolean,
    description: 'For a series, whether it is hidden.',
  },
  seriesIsCloudOnly: {
    ...nullableBoolean,
    description: 'For a series, whether only the store lists it.',
  },
} as const;

export class LibraryAssetsStream extends BooksStream<
  typeof properties,
  LibraryAsset
> {
  readonly name = 'libraryAssets';
  readonly store = 'library';
  readonly primaryKey = ['assetId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per book, PDF, audiobook or series in the Books library on this Mac (BKLibrary). Reading state that syncs across devices, including books not in this library, is in assetDetails. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: BooksScan): readonly LibraryAsset[] {
    return scan.library.assets();
  }

  protected record(asset: LibraryAsset): RecordDraft<typeof properties> {
    return {
      assetId: asset.assetId,
      title: asset.title,
      sortTitle: asset.sortTitle,
      author: asset.author,
      sortAuthor: asset.sortAuthor,
      authorCount: asset.authorCount,
      authorNames: base64(asset.authorNames),
      narratorCount: asset.narratorCount,
      narratorNames: base64(asset.narratorNames),
      genre: asset.genre,
      genres: base64(asset.genres),
      language: asset.language,
      bookDescription: asset.bookDescription,
      comments: asset.comments,
      grouping: asset.grouping,
      year: asset.year,
      kind: asset.kind,
      contentType: asset.contentType,
      contentTypeCode: asset.contentTypeCode,
      mappedAssetId: asset.mappedAssetId,
      mappedAssetContentTypeCode: asset.mappedAssetContentTypeCode,
      temporaryAssetId: asset.temporaryAssetId,
      epubId: asset.epubId,
      assetGuid: asset.assetGuid,
      storeId: asset.storeId,
      storePlaylistId: asset.storePlaylistId,
      familyId: asset.familyId,
      accountId: asset.accountId,
      purchasedDsid: asset.purchasedDsid,
      downloadedDsid: asset.downloadedDsid,
      dataSource: asset.dataSource,
      path: asset.path,
      url: asset.url,
      permalink: asset.permalink,
      coverUrl: asset.coverUrl,
      coverAspectRatio: asset.coverAspectRatio,
      coverWritingMode: asset.coverWritingMode,
      pageProgressionDirection: asset.pageProgressionDirection,
      pageCount: asset.pageCount,
      fileSize: asset.fileSize,
      duration: asset.duration,
      readingProgress: asset.readingProgress,
      highWaterMarkProgress: asset.highWaterMarkProgress,
      isFinished: asset.isFinished,
      notFinished: asset.notFinished,
      finishedDateKind: asset.finishedDateKind,
      finishedAt: iso(asset.finishedAt),
      lastOpenedAt: iso(asset.lastOpenedAt),
      lastEngagedAt: iso(asset.lastEngagedAt),
      createdAt: iso(asset.createdAt),
      modifiedAt: iso(asset.modifiedAt),
      purchasedAt: iso(asset.purchasedAt),
      releasedAt: iso(asset.releasedAt),
      updatedAt: iso(asset.updatedAt),
      expectedAt: iso(asset.expectedAt),
      rating: asset.rating,
      computedRating: asset.computedRating,
      taste: asset.taste,
      tasteSyncedToStore: asset.tasteSyncedToStore,
      isSample: asset.isSample,
      isExplicit: asset.isExplicit,
      isHidden: asset.isHidden,
      isLocked: asset.isLocked,
      isNew: asset.isNew,
      isProof: asset.isProof,
      isDevelopment: asset.isDevelopment,
      isEphemeral: asset.isEphemeral,
      isStoreAudiobook: asset.isStoreAudiobook,
      isSupplementalContent: asset.isSupplementalContent,
      supplementalContentParentAssetId: asset.supplementalContentParentAssetId,
      isTrackedAsRecent: asset.isTrackedAsRecent,
      canRedownload: asset.canRedownload,
      hasReadAloudSupport: asset.hasReadAloudSupport,
      desktopSupportLevel: asset.desktopSupportLevel,
      state: asset.state,
      combinedState: asset.combinedState,
      versionNumber: asset.versionNumber,
      version: asset.version,
      seriesId: asset.seriesId,
      seriesContainerAssetId: asset.seriesContainerAssetId,
      sequenceNumber: asset.sequenceNumber,
      sequenceDisplayName: asset.sequenceDisplayName,
      seriesIsOrdered: asset.seriesIsOrdered,
      seriesIsHidden: asset.seriesIsHidden,
      seriesIsCloudOnly: asset.seriesIsCloudOnly,
    };
  }
}
