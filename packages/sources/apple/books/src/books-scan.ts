import type {
  BookAssetData,
  Books,
  BooksAnnotations,
  BooksLibrary,
  BooksPurchases,
  BooksStore,
  BooksThemes,
  ReadingGoal,
  ReadingHistory,
} from '@workspace/sdk-apple-books';

type Opened = {
  library: BooksLibrary;
  annotations: BooksAnnotations;
  assetData: BookAssetData;
  readingHistory: ReadingHistory;
  purchases: BooksPurchases;
  themes: BooksThemes;
  preferences: ReadingGoal;
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
  readonly #resources: AsyncDisposableStack;
  readonly #stores: OpenedStores;

  private constructor(resources: AsyncDisposableStack, stores: OpenedStores) {
    this.#resources = resources;
    this.#stores = stores;
  }

  static async open(
    books: Books,
    stores: ReadonlySet<BooksStore>,
  ): Promise<BooksScan> {
    await using resources = new AsyncDisposableStack();
    const open = async <S extends BooksStore>(
      store: S,
      value: () => Opened[S] | Promise<Opened[S]>,
    ): Promise<Result<Opened[S]> | undefined> => {
      if (!stores.has(store)) return undefined;
      try {
        return { value: await value() };
      } catch (error) {
        return { error };
      }
    };
    const opened: OpenedStores = {
      library: await open('library', () => resources.use(books.library())),
      annotations: await open('annotations', () =>
        resources.use(books.annotations()),
      ),
      assetData: await open('assetData', () =>
        resources.use(books.assetData()),
      ),
      // Decoded whole while the read transaction pins it, then released.
      readingHistory: await open('readingHistory', () =>
        books.readingHistory(),
      ),
      purchases: await open('purchases', () =>
        resources.use(books.purchases()),
      ),
      themes: await open('themes', () => resources.use(books.themes())),
      preferences: await open('preferences', () => books.readingGoal()),
    };
    return new BooksScan(resources.move(), opened);
  }

  get library(): BooksLibrary {
    return this.#value('library');
  }

  get annotations(): BooksAnnotations {
    return this.#value('annotations');
  }

  get assetData(): BookAssetData {
    return this.#value('assetData');
  }

  get readingHistory(): ReadingHistory {
    return this.#value('readingHistory');
  }

  get purchases(): BooksPurchases {
    return this.#value('purchases');
  }

  get themes(): BooksThemes {
    return this.#value('themes');
  }

  get readingGoal(): ReadingGoal {
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
