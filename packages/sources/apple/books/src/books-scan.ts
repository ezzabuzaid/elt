import { join } from 'node:path';

import type { PlistValue } from '@workspace/macos-plist';

import {
  BooksDatabase,
  booksContainer,
  booksGroupContainer,
  readBooksPlist,
} from './books-store.ts';
import { type ReadingHistory, readingHistory } from './reading-history.ts';

// Where Books keeps each kind of data: Core Data stores it commits to, and
// preference files it rewrites whole.
export type BooksStore =
  | 'library'
  | 'annotations'
  | 'assetData'
  | 'readingHistory'
  | 'purchases'
  | 'themes'
  | 'preferences';

export type BooksLocation = {
  // Books.app's container: library, annotations, themes, preferences.
  readonly container: string;
  // The group container bookdatastored writes: reading state, reading
  // history, store purchases, shared preferences.
  readonly groupContainer: string;
};

export const defaultBooksLocation: BooksLocation = Object.freeze({
  container: booksContainer,
  groupContainer: booksGroupContainer,
});

const bookData = (group: string) =>
  join(group, 'Documents/BCCloudData-BookDataStoreService');

// The file each store keeps; preferences span two files.
export const storeFiles = ({ container, groupContainer }: BooksLocation) =>
  ({
    library: join(
      container,
      'Documents/BKLibrary/BKLibrary-1-091020131601.sqlite',
    ),
    annotations: join(
      container,
      'Documents/AEAnnotation/AEAnnotation_v10312011_1727_local.sqlite',
    ),
    assetData: join(bookData(groupContainer), 'BCAssetData/BCAssetData'),
    readingHistory: join(
      bookData(groupContainer),
      'CRDTModelSync-ReadingHistoryModel/CRDTModelSync-ReadingHistoryModel',
    ),
    purchases: join(
      groupContainer,
      'Documents/BKJaliscoServerSource/BKJaliscoServerSource-v09182016.sqlite',
    ),
    themes: join(
      container,
      'Library/Application Support/Books/BookTheme.sqlite',
    ),
    preferences: join(container, 'Library/Preferences/com.apple.iBooksX.plist'),
  }) satisfies Record<BooksStore, string>;

export const sharedPreferences = ({ groupContainer }: BooksLocation) =>
  join(groupContainer, 'Library/Preferences/group.com.apple.iBooks.plist');

export const databaseStores = new Set<BooksStore>([
  'library',
  'annotations',
  'assetData',
  'readingHistory',
  'purchases',
  'themes',
]);

// The columns each stream reads; opening a store checks them all.
const columns = {
  library: {
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
    ZBKCOLLECTIONMEMBER: [
      'ZCOLLECTION',
      'ZASSETID',
      'ZSORTKEY',
      'ZLOCALMODDATE',
    ],
  },
  annotations: {
    ZAEANNOTATION: [
      'ZANNOTATIONUUID',
      'ZANNOTATIONASSETID',
      'ZANNOTATIONTYPE',
      'ZANNOTATIONSTYLE',
      'ZANNOTATIONISUNDERLINE',
      'ZANNOTATIONDELETED',
      'ZANNOTATIONSELECTEDTEXT',
      'ZANNOTATIONREPRESENTATIVETEXT',
      'ZANNOTATIONNOTE',
      'ZANNOTATIONLOCATION',
      'ZPLLOCATIONRANGESTART',
      'ZPLLOCATIONRANGEEND',
      'ZPLABSOLUTEPHYSICALLOCATION',
      'ZPLSTORAGEUUID',
      'ZANNOTATIONCREATORIDENTIFIER',
      'ZANNOTATIONCREATIONDATE',
      'ZANNOTATIONMODIFICATIONDATE',
      'ZFUTUREPROOFING5',
    ],
  },
  assetData: {
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
  },
  readingHistory: {
    ZCRDTMODELSYNCENTITY: ['ZTYPE', 'ZDELETEDFLAG', 'ZPROTODATA'],
  },
  purchases: {
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
  },
  themes: {
    ZBOOKTHEME: [
      'ZIDENTIFIER',
      'ZHASCUSTOMLAYOUT',
      'ZISFONTBOLDED',
      'ZJUSTIFY',
      'ZMULTIPLECOLUMNMODE',
      'ZLETTERSPACING',
      'ZLINEHEIGHT',
      'ZMARGINADJUSTMENT',
      'ZWORDSPACING',
    ],
  },
} satisfies Partial<
  Record<BooksStore, Readonly<Record<string, readonly string[]>>>
>;

export type Preferences = {
  readonly app: PlistValue;
  readonly shared: PlistValue;
};

type Opened = {
  library: BooksDatabase;
  annotations: BooksDatabase;
  assetData: BooksDatabase;
  readingHistory: ReadingHistory;
  purchases: BooksDatabase;
  themes: BooksDatabase;
  preferences: Preferences;
};

// A store's contents, or why it could not be opened.
type Result<T> = { readonly value: T } | { readonly error: unknown };
type OpenedStores = { [S in BooksStore]?: Result<Opened[S]> };

// One run's read of the Books stores the selected streams need: each
// database pinned to one read transaction, each preference file read once.
// Stores are separate files, so streams of different stores need not agree,
// and a store that cannot be opened fails only the streams that read it.
// Disposing it ends the read transactions.
export class BooksScan implements AsyncDisposable {
  readonly location: BooksLocation;
  readonly #resources: AsyncDisposableStack;
  readonly #stores: OpenedStores;

  private constructor(
    location: BooksLocation,
    resources: AsyncDisposableStack,
    stores: OpenedStores,
  ) {
    this.location = location;
    this.#resources = resources;
    this.#stores = stores;
  }

  static async open(
    location: BooksLocation,
    stores: ReadonlySet<BooksStore>,
  ): Promise<BooksScan> {
    const files = storeFiles(location);
    await using resources = new AsyncDisposableStack();
    const database = async (
      store: Exclude<BooksStore, 'readingHistory' | 'preferences'>,
    ) => resources.use(new BooksDatabase(files[store], columns[store]));
    const open = async <S extends BooksStore>(
      store: S,
      value: () => Promise<Opened[S]>,
    ): Promise<Result<Opened[S]> | undefined> => {
      if (!stores.has(store)) return undefined;
      try {
        return { value: await value() };
      } catch (error) {
        return { error };
      }
    };
    const opened: OpenedStores = {
      library: await open('library', () => database('library')),
      annotations: await open('annotations', () => database('annotations')),
      assetData: await open('assetData', () => database('assetData')),
      // Decoded whole while the read transaction pins it, then released.
      readingHistory: await open('readingHistory', async () => {
        using store = new BooksDatabase(
          files.readingHistory,
          columns.readingHistory,
        );
        const rows = store.all(
          "SELECT ZPROTODATA FROM ZCRDTMODELSYNCENTITY WHERE ZTYPE = 'ReadingHistoryModel' AND coalesce(ZDELETEDFLAG, 0) = 0",
        );
        const bytes = rows[0]?.ZPROTODATA;
        if (rows.length !== 1 || !(bytes instanceof Uint8Array))
          return { months: [], days: [], streaks: [] };
        return readingHistory(bytes, files.readingHistory);
      }),
      purchases: await open('purchases', () => database('purchases')),
      themes: await open('themes', () => database('themes')),
      preferences: await open('preferences', async () => ({
        app: await readBooksPlist(files.preferences),
        shared: await readBooksPlist(sharedPreferences(location)),
      })),
    };
    return new BooksScan(location, resources.move(), opened);
  }

  get library(): BooksDatabase {
    return this.#value('library');
  }

  get annotations(): BooksDatabase {
    return this.#value('annotations');
  }

  get assetData(): BooksDatabase {
    return this.#value('assetData');
  }

  get readingHistory(): ReadingHistory {
    return this.#value('readingHistory');
  }

  get purchases(): BooksDatabase {
    return this.#value('purchases');
  }

  get themes(): BooksDatabase {
    return this.#value('themes');
  }

  get preferences(): Preferences {
    return this.#value('preferences');
  }

  #value<S extends BooksStore>(store: S): Opened[S] {
    const opened: Result<Opened[S]> | undefined = this.#stores[store];
    if (opened === undefined)
      throw new Error(`Books ${store} was not opened for this run`);
    if ('error' in opened) throw opened.error;
    return opened.value;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.#resources.disposeAsync();
  }
}
