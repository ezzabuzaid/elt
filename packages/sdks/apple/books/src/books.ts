import { BookAssetData } from './book-asset-data.ts';
import { BooksAnnotations } from './books-annotations.ts';
import { BooksLibrary } from './books-library.ts';
import {
  type BooksLocation,
  type BooksStore,
  sharedPreferences,
  storeFiles,
} from './books-location.ts';
import { BooksPurchases } from './books-purchases.ts';
import { BooksThemes } from './books-themes.ts';
import { BooksVersion } from './books-version.ts';
import { type ReadingGoal, readingGoal } from './reading-goal.ts';
import { type ReadingHistory, readingHistory } from './reading-history.ts';

// The stores Books and bookdatastored keep, read without Books, which need
// not run. Each database opens read-only, pinned to one moment, and checks
// the columns this reader reads.
export class Books {
  readonly location: BooksLocation;

  constructor(location: BooksLocation) {
    this.location = location;
  }

  library(): BooksLibrary {
    return new BooksLibrary(storeFiles(this.location).library);
  }

  annotations(): BooksAnnotations {
    return new BooksAnnotations(storeFiles(this.location).annotations);
  }

  assetData(): BookAssetData {
    return new BookAssetData(storeFiles(this.location).assetData);
  }

  readingHistory(): ReadingHistory {
    return readingHistory(storeFiles(this.location).readingHistory);
  }

  purchases(): BooksPurchases {
    return new BooksPurchases(storeFiles(this.location).purchases);
  }

  themes(): BooksThemes {
    return new BooksThemes(storeFiles(this.location).themes);
  }

  readingGoal(): Promise<ReadingGoal> {
    return readingGoal(
      storeFiles(this.location).preferences,
      sharedPreferences(this.location),
    );
  }

  // A probe whose current value changes when the store does.
  version(store: BooksStore): BooksVersion {
    return new BooksVersion(this.location, store);
  }
}
