import { mkdtempDisposable, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pollChanges } from '@zukhruf/async';
import { ClosedWorld } from '@zukhruf/snapshot-differential';

import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Catalog, Source, diffSnapshot } from '@workspace/elt';
import {
  Books,
  type BooksLocation,
  type BooksStore,
  StoreUnavailableError,
} from '@workspace/sdk-apple-books';
import { localAppleStoreCoverage } from '@workspace/source-apple-macos/local-apple-store-coverage';

import { BooksScan } from './books-scan.ts';
import type { BooksReader } from './books-stream.ts';
import { AnnotationsStream } from './streams/annotations-stream.ts';
import { AssetDetailsStream } from './streams/asset-details-stream.ts';
import { BookFilesStream } from './streams/book-files-stream.ts';
import { CollectionMembersStream } from './streams/collection-members-stream.ts';
import { CollectionsStream } from './streams/collections-stream.ts';
import { LibraryAssetsStream } from './streams/library-assets-stream.ts';
import { PurchasesStream } from './streams/purchases-stream.ts';
import { ReadingGoalStream } from './streams/reading-goal-stream.ts';
import {
  ReadingDaysStream,
  ReadingMonthsStream,
  StreakRecordsStream,
} from './streams/reading-history-streams.ts';
import { ReviewsStream } from './streams/reviews-stream.ts';
import { ThemesStream } from './streams/themes-stream.ts';

const readers = {
  libraryAssets: new LibraryAssetsStream(),
  collections: new CollectionsStream(),
  collectionMembers: new CollectionMembersStream(),
  bookFiles: new BookFilesStream(),
  annotations: new AnnotationsStream(),
  assetDetails: new AssetDetailsStream(),
  reviews: new ReviewsStream(),
  readingMonths: new ReadingMonthsStream(),
  readingDays: new ReadingDaysStream(),
  streakRecords: new StreakRecordsStream(),
  readingGoal: new ReadingGoalStream(),
  purchases: new PurchasesStream(),
  themes: new ThemesStream(),
} satisfies Record<string, BooksReader>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);

const readersByName = new Map<string, BooksReader>(
  Object.values(readers).map((reader) => [reader.name, reader]),
);
const readerOf = (stream: Stream): BooksReader => {
  const reader = readersByName.get(stream.name);
  if (reader === undefined)
    throw new Error(`Apple Books has no stream ${stream.name}`);
  return reader;
};

// How often a watch checks the stores for changes.
const pollIntervalMs = 1000;

// Reads Books' own stores, so Books need not run to export. What Books syncs
// from the user's other devices is what bookdatastored last fetched.
export class AppleBooksSource extends Source<BooksScan> {
  readonly identity = 'apple-books';
  protected readonly catalog = catalog;
  readonly libraryAssets = catalog.get(readers.libraryAssets.name);
  readonly collections = catalog.get(readers.collections.name);
  readonly collectionMembers = catalog.get(readers.collectionMembers.name);
  readonly bookFiles = catalog.get(readers.bookFiles.name);
  readonly annotations = catalog.get(readers.annotations.name);
  readonly assetDetails = catalog.get(readers.assetDetails.name);
  readonly reviews = catalog.get(readers.reviews.name);
  readonly readingMonths = catalog.get(readers.readingMonths.name);
  readonly readingDays = catalog.get(readers.readingDays.name);
  readonly streakRecords = catalog.get(readers.streakRecords.name);
  readonly readingGoal = catalog.get(readers.readingGoal.name);
  readonly purchases = catalog.get(readers.purchases.name);
  readonly themes = catalog.get(readers.themes.name);

  readonly location: BooksLocation;
  readonly #books: Books;

  constructor({ container, groupContainer }: BooksLocation) {
    super();
    this.location = Object.freeze({ container, groupContainer });
    this.#books = new Books(this.location);
    Object.freeze(this);
  }

  protected override open(streams: readonly Stream[]): Promise<BooksScan> {
    return BooksScan.open(
      this.#books,
      new Set(streams.map((stream) => readerOf(stream).store)),
    );
  }

  protected override readonly configErrors = [StoreUnavailableError];

  override coverage(_stream: Stream): ExtractionCoverage {
    return localAppleStoreCoverage;
  }

  override async currentAsOf() {
    return null;
  }

  // Each store the streams read reports its own changes. A book downloaded
  // from iCloud without a library change is picked up by the next change or
  // run.
  protected override async *observe({
    streams,
    signal,
    clock,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using versions = new DisposableStack();
    const reads = new Map(
      [...new Set(streams.map((stream) => readerOf(stream).store))].map(
        (store) => {
          const probe = versions.use(this.#books.version(store));
          return [store, () => probe.current()];
        },
      ),
    );
    for await (const changed of pollChanges(reads, {
      interval: pollIntervalMs,
      signal,
      clock,
    }))
      yield streams.filter((stream) => changed.has(readerOf(stream).store));
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: BooksScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readerOf(stream);
    const records = reader.read(scan);
    const messages = diffSnapshot(configuration, records, state, {
      policy: new ClosedWorld(),
      signal,
    });
    if (configuration.fileReads.length === 0) {
      yield* messages;
      return;
    }
    // Only records the diff emits are staged, one at a time.
    await using staging = await mkdtempDisposable(join(tmpdir(), 'elt-books-'));
    for await (const message of messages) {
      if ('type' in message) {
        yield message;
        continue;
      }
      const file = await reader.file(message.data, scan, staging.path);
      yield { ...message, file };
      if (file?.startsWith(staging.path)) await rm(file, { force: true });
    }
  }
}
