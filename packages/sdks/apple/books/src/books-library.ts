import { AppDatabase } from '@workspace/sdk-apple-app-database';

import { type BookFile, bookFile } from './book-files.ts';
import {
  type Row,
  bytes,
  coreDataTime,
  flag,
  integer,
  nullableFlag,
  number,
  stored,
  text,
} from './books-values.ts';
import { BooksSchemaError, BooksUnavailableError } from './errors.ts';

// The BKLibrary columns this reader reads; opening the library checks them.
const libraryColumns = {
  ZBKLIBRARYASSET: [
    'Z_PK',
    'ZASSETID',
    'ZTITLE',
    'ZSORTTITLE',
    'ZAUTHOR',
    'ZSORTAUTHOR',
    'ZAUTHORCOUNT',
    'ZAUTHORNAMES',
    'ZNARRATORCOUNT',
    'ZNARRATORNAMES',
    'ZGENRE',
    'ZGENRES',
    'ZLANGUAGE',
    'ZBOOKDESCRIPTION',
    'ZCOMMENTS',
    'ZGROUPING',
    'ZYEAR',
    'ZKIND',
    'ZCONTENTTYPE',
    'ZMAPPEDASSETCONTENTTYPE',
    'ZMAPPEDASSETID',
    'ZTEMPORARYASSETID',
    'ZEPUBID',
    'ZASSETGUID',
    'ZSTOREID',
    'ZSTOREPLAYLISTID',
    'ZFAMILYID',
    'ZACCOUNTID',
    'ZPURCHASEDDSID',
    'ZDOWNLOADEDDSID',
    'ZDATASOURCEIDENTIFIER',
    'ZPATH',
    'ZURL',
    'ZPERMLINK',
    'ZCOVERURL',
    'ZCOVERASPECTRATIO',
    'ZCOVERWRITINGMODE',
    'ZPAGEPROGRESSIONDIRECTION',
    'ZPAGECOUNT',
    'ZFILESIZE',
    'ZDURATION',
    'ZREADINGPROGRESS',
    'ZBOOKHIGHWATERMARKPROGRESS',
    'ZISFINISHED',
    'ZNOTFINISHED',
    'ZFINISHEDDATEKIND',
    'ZDATEFINISHED',
    'ZLASTOPENDATE',
    'ZLASTENGAGEDDATE',
    'ZCREATIONDATE',
    'ZMODIFICATIONDATE',
    'ZPURCHASEDATE',
    'ZRELEASEDATE',
    'ZUPDATEDATE',
    'ZEXPECTEDDATE',
    'ZRATING',
    'ZCOMPUTEDRATING',
    'ZTASTE',
    'ZTASTESYNCEDTOSTORE',
    'ZISSAMPLE',
    'ZISEXPLICIT',
    'ZISHIDDEN',
    'ZISLOCKED',
    'ZISNEW',
    'ZISPROOF',
    'ZISDEVELOPMENT',
    'ZISEPHEMERAL',
    'ZISSTOREAUDIOBOOK',
    'ZISSUPPLEMENTALCONTENT',
    'ZISTRACKEDASRECENT',
    'ZCANREDOWNLOAD',
    'ZHASRACSUPPORT',
    'ZDESKTOPSUPPORTLEVEL',
    'ZSTATE',
    'ZCOMBINEDSTATE',
    'ZVERSIONNUMBER',
    'ZVERSIONNUMBERHUMANREADABLE',
    'ZSERIESID',
    'ZSERIESCONTAINER',
    'ZSEQUENCENUMBER',
    'ZSEQUENCEDISPLAYNAME',
    'ZSERIESISORDERED',
    'ZSERIESISHIDDEN',
    'ZSERIESISCLOUDONLY',
    'ZSUPPLEMENTALCONTENTPARENT',
  ],
  ZBKCOLLECTION: [
    'Z_PK',
    'ZCOLLECTIONID',
    'ZTITLE',
    'ZDETAILS',
    'ZDELETEDFLAG',
    'ZHIDDEN',
    'ZPLACEHOLDER',
    'ZSORTKEY',
    'ZSORTMODE',
    'ZVIEWMODE',
    'ZLASTMODIFICATION',
    'ZLOCALMODDATE',
  ],
  ZBKCOLLECTIONMEMBER: ['ZCOLLECTION', 'ZASSETID', 'ZSORTKEY', 'ZLOCALMODDATE'],
} as const;

const assetsQuery = `
      SELECT asset.*,
        container.ZASSETID AS seriesContainerAssetId,
        parent.ZASSETID AS supplementalContentParentAssetId
      FROM ZBKLIBRARYASSET asset
      LEFT JOIN ZBKLIBRARYASSET container ON container.Z_PK = asset.ZSERIESCONTAINER
      LEFT JOIN ZBKLIBRARYASSET parent ON parent.Z_PK = asset.ZSUPPLEMENTALCONTENTPARENT
      WHERE asset.ZASSETID IS NOT NULL
      ORDER BY asset.Z_PK`;

const collectionMembersQuery = `
      SELECT collection.ZCOLLECTIONID AS collectionId, member.ZASSETID,
        member.ZSORTKEY, member.ZLOCALMODDATE
      FROM ZBKCOLLECTIONMEMBER member
      JOIN ZBKCOLLECTION collection ON collection.Z_PK = member.ZCOLLECTION
      WHERE collection.ZCOLLECTIONID IS NOT NULL AND member.ZASSETID IS NOT NULL
      ORDER BY member.Z_PK`;

export const contentTypes = ['epub', 'pdf'] as const;
export type ContentType = (typeof contentTypes)[number];

// Only codes verified against a live library; others keep their code alone.
const contentTypesByCode = new Map<number, ContentType>([
  [1, 'epub'],
  [3, 'pdf'],
]);

// A book, audiobook or PDF in the library, as BKLibrary keeps it. Lists of
// author, narrator and genre names are archived bytes Books has not been seen
// to fill.
export type LibraryAsset = {
  readonly assetId: string | null;
  readonly title: string | null;
  readonly sortTitle: string | null;
  readonly author: string | null;
  readonly sortAuthor: string | null;
  readonly authorCount: number | null;
  readonly authorNames: Uint8Array | null;
  readonly narratorCount: number | null;
  readonly narratorNames: Uint8Array | null;
  readonly genre: string | null;
  readonly genres: Uint8Array | null;
  readonly language: string | null;
  readonly bookDescription: string | null;
  readonly comments: string | null;
  readonly grouping: string | null;
  readonly year: string | null;
  readonly kind: string | null;
  readonly contentType: ContentType | null;
  readonly contentTypeCode: number | null;
  readonly mappedAssetId: string | null;
  readonly mappedAssetContentTypeCode: number | null;
  readonly temporaryAssetId: string | null;
  readonly epubId: string | null;
  readonly assetGuid: string | null;
  readonly storeId: string | null;
  readonly storePlaylistId: string | null;
  readonly familyId: string | null;
  readonly accountId: string | null;
  readonly purchasedDsid: string | null;
  readonly downloadedDsid: string | null;
  readonly dataSource: string | null;
  readonly path: string | null;
  readonly url: string | null;
  readonly permalink: string | null;
  readonly coverUrl: string | null;
  readonly coverAspectRatio: number | null;
  readonly coverWritingMode: string | null;
  readonly pageProgressionDirection: string | null;
  readonly pageCount: number | null;
  readonly fileSize: number | null;
  readonly duration: number | null;
  readonly readingProgress: number | null;
  readonly highWaterMarkProgress: number | null;
  readonly isFinished: boolean;
  readonly notFinished: boolean | null;
  readonly finishedDateKind: number | null;
  readonly finishedAt: Date | null;
  readonly lastOpenedAt: Date | null;
  readonly lastEngagedAt: Date | null;
  readonly createdAt: Date | null;
  readonly modifiedAt: Date | null;
  readonly purchasedAt: Date | null;
  readonly releasedAt: Date | null;
  readonly updatedAt: Date | null;
  readonly expectedAt: Date | null;
  readonly rating: number | null;
  readonly computedRating: number | null;
  readonly taste: number | null;
  readonly tasteSyncedToStore: boolean | null;
  readonly isSample: boolean;
  readonly isExplicit: boolean | null;
  readonly isHidden: boolean;
  readonly isLocked: boolean | null;
  readonly isNew: boolean | null;
  readonly isProof: boolean | null;
  readonly isDevelopment: boolean | null;
  readonly isEphemeral: boolean | null;
  readonly isStoreAudiobook: boolean | null;
  readonly isSupplementalContent: boolean | null;
  readonly supplementalContentParentAssetId: string | null;
  readonly isTrackedAsRecent: boolean | null;
  readonly canRedownload: boolean | null;
  readonly hasReadAloudSupport: boolean | null;
  readonly desktopSupportLevel: number | null;
  readonly state: number | null;
  readonly combinedState: number | null;
  readonly versionNumber: number | null;
  readonly version: string | null;
  readonly seriesId: string | null;
  readonly seriesContainerAssetId: string | null;
  readonly sequenceNumber: number | null;
  readonly sequenceDisplayName: string | null;
  readonly seriesIsOrdered: boolean | null;
  readonly seriesIsHidden: boolean | null;
  readonly seriesIsCloudOnly: boolean | null;
};

export type Collection = {
  readonly collectionId: string | null;
  readonly title: string | null;
  readonly details: string | null;
  readonly deleted: boolean;
  readonly hidden: boolean;
  readonly placeholder: boolean;
  readonly sortKey: number | null;
  readonly sortMode: number | null;
  readonly viewMode: number | null;
  readonly modifiedAt: Date | null;
  readonly localModifiedAt: Date | null;
};

export type CollectionMember = {
  readonly collectionId: string | null;
  readonly assetId: string | null;
  readonly sortKey: number | null;
  readonly addedAt: Date | null;
};

const libraryAsset = (row: Row): LibraryAsset => {
  const contentTypeCode = integer(row.ZCONTENTTYPE);
  return {
    assetId: stored(row.ZASSETID),
    title: text(row.ZTITLE),
    sortTitle: text(row.ZSORTTITLE),
    author: text(row.ZAUTHOR),
    sortAuthor: text(row.ZSORTAUTHOR),
    authorCount: integer(row.ZAUTHORCOUNT),
    authorNames: bytes(row.ZAUTHORNAMES),
    narratorCount: integer(row.ZNARRATORCOUNT),
    narratorNames: bytes(row.ZNARRATORNAMES),
    genre: text(row.ZGENRE),
    genres: bytes(row.ZGENRES),
    language: text(row.ZLANGUAGE),
    bookDescription: text(row.ZBOOKDESCRIPTION),
    comments: text(row.ZCOMMENTS),
    grouping: text(row.ZGROUPING),
    year: text(row.ZYEAR),
    kind: text(row.ZKIND),
    contentType:
      contentTypeCode === null
        ? null
        : (contentTypesByCode.get(contentTypeCode) ?? null),
    contentTypeCode,
    mappedAssetId: text(row.ZMAPPEDASSETID),
    mappedAssetContentTypeCode: integer(row.ZMAPPEDASSETCONTENTTYPE),
    temporaryAssetId: text(row.ZTEMPORARYASSETID),
    epubId: text(row.ZEPUBID),
    assetGuid: text(row.ZASSETGUID),
    storeId: text(row.ZSTOREID),
    storePlaylistId: text(row.ZSTOREPLAYLISTID),
    familyId: text(row.ZFAMILYID),
    accountId: text(row.ZACCOUNTID),
    purchasedDsid: text(row.ZPURCHASEDDSID),
    downloadedDsid: text(row.ZDOWNLOADEDDSID),
    dataSource: text(row.ZDATASOURCEIDENTIFIER),
    path: text(row.ZPATH),
    url: text(row.ZURL),
    permalink: text(row.ZPERMLINK),
    coverUrl: text(row.ZCOVERURL),
    coverAspectRatio: number(row.ZCOVERASPECTRATIO),
    coverWritingMode: text(row.ZCOVERWRITINGMODE),
    pageProgressionDirection: text(row.ZPAGEPROGRESSIONDIRECTION),
    pageCount: integer(row.ZPAGECOUNT),
    fileSize: integer(row.ZFILESIZE),
    duration: number(row.ZDURATION),
    readingProgress: number(row.ZREADINGPROGRESS),
    highWaterMarkProgress: number(row.ZBOOKHIGHWATERMARKPROGRESS),
    isFinished: flag(row.ZISFINISHED),
    notFinished: nullableFlag(row.ZNOTFINISHED),
    finishedDateKind: integer(row.ZFINISHEDDATEKIND),
    finishedAt: coreDataTime(row.ZDATEFINISHED),
    lastOpenedAt: coreDataTime(row.ZLASTOPENDATE),
    lastEngagedAt: coreDataTime(row.ZLASTENGAGEDDATE),
    createdAt: coreDataTime(row.ZCREATIONDATE),
    modifiedAt: coreDataTime(row.ZMODIFICATIONDATE),
    purchasedAt: coreDataTime(row.ZPURCHASEDATE),
    releasedAt: coreDataTime(row.ZRELEASEDATE),
    updatedAt: coreDataTime(row.ZUPDATEDATE),
    expectedAt: coreDataTime(row.ZEXPECTEDDATE),
    rating: integer(row.ZRATING),
    computedRating: integer(row.ZCOMPUTEDRATING),
    taste: integer(row.ZTASTE),
    tasteSyncedToStore: nullableFlag(row.ZTASTESYNCEDTOSTORE),
    isSample: flag(row.ZISSAMPLE),
    isExplicit: nullableFlag(row.ZISEXPLICIT),
    isHidden: flag(row.ZISHIDDEN),
    isLocked: nullableFlag(row.ZISLOCKED),
    isNew: nullableFlag(row.ZISNEW),
    isProof: nullableFlag(row.ZISPROOF),
    isDevelopment: nullableFlag(row.ZISDEVELOPMENT),
    isEphemeral: nullableFlag(row.ZISEPHEMERAL),
    isStoreAudiobook: nullableFlag(row.ZISSTOREAUDIOBOOK),
    isSupplementalContent: nullableFlag(row.ZISSUPPLEMENTALCONTENT),
    supplementalContentParentAssetId: text(
      row.supplementalContentParentAssetId,
    ),
    isTrackedAsRecent: nullableFlag(row.ZISTRACKEDASRECENT),
    canRedownload: nullableFlag(row.ZCANREDOWNLOAD),
    hasReadAloudSupport: nullableFlag(row.ZHASRACSUPPORT),
    desktopSupportLevel: integer(row.ZDESKTOPSUPPORTLEVEL),
    state: integer(row.ZSTATE),
    combinedState: integer(row.ZCOMBINEDSTATE),
    versionNumber: number(row.ZVERSIONNUMBER),
    version: text(row.ZVERSIONNUMBERHUMANREADABLE),
    seriesId: text(row.ZSERIESID),
    seriesContainerAssetId: text(row.seriesContainerAssetId),
    sequenceNumber: number(row.ZSEQUENCENUMBER),
    sequenceDisplayName: text(row.ZSEQUENCEDISPLAYNAME),
    seriesIsOrdered: nullableFlag(row.ZSERIESISORDERED),
    seriesIsHidden: nullableFlag(row.ZSERIESISHIDDEN),
    seriesIsCloudOnly: nullableFlag(row.ZSERIESISCLOUDONLY),
  };
};

// BKLibrary as Books last saved it: the assets in the library and the
// collections they are filed in, pinned to one moment.
export class BooksLibrary implements Disposable {
  readonly #database: AppDatabase;

  constructor(path: string) {
    this.#database = new AppDatabase(path, BooksUnavailableError);
    this.#database.requireColumns(libraryColumns, BooksSchemaError);
  }

  assets(): LibraryAsset[] {
    return this.#database.all(assetsQuery).map(libraryAsset);
  }

  collections(): Collection[] {
    return this.#database
      .all(
        'SELECT * FROM ZBKCOLLECTION WHERE ZCOLLECTIONID IS NOT NULL ORDER BY Z_PK',
      )
      .map((row) => ({
        collectionId: stored(row.ZCOLLECTIONID),
        title: text(row.ZTITLE),
        details: text(row.ZDETAILS),
        deleted: flag(row.ZDELETEDFLAG),
        hidden: flag(row.ZHIDDEN),
        placeholder: flag(row.ZPLACEHOLDER),
        sortKey: integer(row.ZSORTKEY),
        sortMode: integer(row.ZSORTMODE),
        viewMode: integer(row.ZVIEWMODE),
        modifiedAt: coreDataTime(row.ZLASTMODIFICATION),
        localModifiedAt: coreDataTime(row.ZLOCALMODDATE),
      }));
  }

  collectionMembers(): CollectionMember[] {
    return this.#database.all(collectionMembersQuery).map((row) => ({
      collectionId: stored(row.collectionId),
      assetId: stored(row.ZASSETID),
      sortKey: integer(row.ZSORTKEY),
      addedAt: coreDataTime(row.ZLOCALMODDATE),
    }));
  }

  // Each asset's file or package and what of it is on this Mac, read from
  // iCloud's file flags so no placeholder is downloaded.
  async bookFiles(): Promise<BookFile[]> {
    const files: BookFile[] = [];
    for (const row of this.#database.all(
      'SELECT ZASSETID, ZPATH FROM ZBKLIBRARYASSET WHERE ZASSETID IS NOT NULL AND ZPATH IS NOT NULL ORDER BY Z_PK',
    ))
      // The query selects only rows whose ZASSETID and ZPATH are not null.
      files.push(await bookFile(String(row.ZASSETID), String(row.ZPATH)));
    return files;
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}
