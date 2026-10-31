import { join } from 'node:path';

export type BooksLocation = {
  // Books.app's container: library, annotations, themes, preferences.
  readonly container: string;
  // The group container bookdatastored writes: reading state, reading
  // history, store purchases, shared preferences.
  readonly groupContainer: string;
};

// Where Books keeps its two containers in the home folder `home`.
export const booksLocation = (home: string): BooksLocation => ({
  container: join(home, 'Library/Containers/com.apple.iBooksX/Data'),
  groupContainer: join(home, 'Library/Group Containers/group.com.apple.iBooks'),
});

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
