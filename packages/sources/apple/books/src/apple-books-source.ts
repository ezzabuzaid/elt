import { mkdtempDisposable, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setInterval } from 'node:timers/promises';

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
  type BooksVersion,
  booksContainer,
  booksGroupContainer,
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
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly libraryAssets = readers.libraryAssets.describe();
  readonly collections = readers.collections.describe();
  readonly collectionMembers = readers.collectionMembers.describe();
  readonly bookFiles = readers.bookFiles.describe();
  readonly annotations = readers.annotations.describe();
  readonly assetDetails = readers.assetDetails.describe();
  readonly reviews = readers.reviews.describe();
  readonly readingMonths = readers.readingMonths.describe();
  readonly readingDays = readers.readingDays.describe();
  readonly streakRecords = readers.streakRecords.describe();
  readonly readingGoal = readers.readingGoal.describe();
  readonly purchases = readers.purchases.describe();
  readonly themes = readers.themes.describe();

  readonly location: BooksLocation;
  readonly #books: Books;

  constructor({
    container = booksContainer,
    groupContainer = booksGroupContainer,
  }: {
    container?: string;
    groupContainer?: string;
  } = {}) {
    super();
    this.location = Object.freeze({ container, groupContainer });
    this.#books = new Books(this.location);
    this.identity = `apple-books:${container}:${groupContainer}`;
    Object.freeze(this);
  }

  protected override open(streams: readonly Stream[]): Promise<BooksScan> {
    return BooksScan.open(
      this.#books,
      new Set(streams.map((stream) => readerOf(stream).store)),
    );
  }

  override coverage(_stream: Stream): ExtractionCoverage {
    return localAppleStoreCoverage;
  }

  // Each store the streams read reports its own changes. A book downloaded
  // from iCloud without a library change is picked up by the next change or
  // run.
  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using versions = new DisposableStack();
    const probes = new Map<BooksStore, BooksVersion>(
      [...new Set(streams.map((stream) => readerOf(stream).store))].map(
        (store) => [store, versions.use(this.#books.version(store))],
      ),
    );
    const seen = new Map<BooksStore, string>();
    for (const [store, probe] of probes) seen.set(store, await probe.current());
    yield streams;
    try {
      for await (const _ of setInterval(pollIntervalMs, undefined, {
        signal,
      })) {
        const changed = new Set<BooksStore>();
        for (const [store, probe] of probes) {
          const current = await probe.current();
          if (current === seen.get(store)) continue;
          seen.set(store, current);
          changed.add(store);
        }
        if (changed.size > 0)
          yield streams.filter((stream) => changed.has(readerOf(stream).store));
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) throw error;
    }
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: BooksScan,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readerOf(stream);
    const records = await reader.read(scan);
    const messages =
      configuration.syncMode === 'incremental'
        ? diffSnapshot(stream, records, state)
        : records.map((data) => ({ stream: stream.name, data }));
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
