import { join } from 'node:path';

import { pollChanges } from '@zukhruf/async';

import {
  Catalog,
  type CopyConfiguration,
  type ExtractionCoverage,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  type Stream,
  diffSnapshot,
} from '@workspace/elt';
import {
  BookmarksUnavailableError,
  ChromiumBookmarks,
} from '@workspace/sdk-chromium-bookmarks';
import type { ChromiumBrowser } from '@workspace/sdk-chromium-browser';
import {
  ChromiumHistoryUnavailableError,
  chromiumHistoryLastWrite,
  chromiumHistoryVersion,
} from '@workspace/sdk-chromium-history';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import {
  ChromiumScan,
  type ChromiumStore,
  selectedProfiles,
  storeFiles,
} from './chromium-scan.ts';
import type { ChromiumReader } from './chromium-stream.ts';
import { BookmarksStream } from './streams/bookmarks-stream.ts';
import { DownloadsStream } from './streams/downloads-stream.ts';
import { HistoryItemsStream } from './streams/history-items-stream.ts';
import { HistoryVisitsStream } from './streams/history-visits-stream.ts';
import { ProfilesStream } from './streams/profiles-stream.ts';
import { SearchTermsStream } from './streams/search-terms-stream.ts';

// The streams of a browser that removes old history, or of one that keeps
// it: only the first has expiresAt on its history streams, so the two
// catalogs differ, and each is shared by every source of its kind.
class ChromiumCatalog {
  readonly readers;
  readonly catalog: Catalog;
  readonly #byName: ReadonlyMap<string, ChromiumReader>;

  constructor(expires: boolean) {
    this.readers = {
      profiles: new ProfilesStream(),
      historyItems: new HistoryItemsStream(expires),
      historyVisits: new HistoryVisitsStream(expires),
      downloads: new DownloadsStream(),
      searchTerms: new SearchTermsStream(expires),
      bookmarks: new BookmarksStream(),
    } satisfies Record<string, ChromiumReader>;
    const readers: ChromiumReader[] = Object.values(this.readers);
    this.catalog = new Catalog(readers.map((reader) => reader.describe()));
    this.#byName = new Map(readers.map((reader) => [reader.name, reader]));
  }

  readerOf(stream: Stream): ChromiumReader {
    const reader = this.#byName.get(stream.name);
    if (reader === undefined)
      throw new TypeError(`Chromium has no ${stream.name} stream`);
    return reader;
  }
}

const expiring = new ChromiumCatalog(true);
const keeping = new ChromiumCatalog(false);

// How often a watch checks the stores for changes.
const pollIntervalMs = 1000;

// Reads the history, downloads, searches and bookmarks of every profile of
// one Chromium browser, such as Dia or Chrome, from its own files, so the
// browser need not run. Its identity names the browser, so each browser
// keeps its own checkpoints.
export class ChromiumSource extends Source<ChromiumScan> {
  readonly identity: string;
  protected readonly catalog: Catalog;
  readonly profiles: Stream;
  readonly historyItems: Stream;
  readonly historyVisits: Stream;
  readonly downloads: Stream;
  readonly searchTerms: Stream;
  readonly bookmarks: Stream;

  readonly browser: ChromiumBrowser;
  readonly home: string;
  readonly scope: ImportScope;
  readonly #streams: ChromiumCatalog;

  // home: the user's home folder, which holds the browser's data folder.
  // scope: collectionIds are profile folders, and select every stream;
  // startAt and endAt select visits.
  constructor({
    browser,
    home,
    scope = {},
  }: {
    browser: ChromiumBrowser;
    home: string;
    scope?: ImportScope;
  }) {
    super();
    this.browser = browser;
    this.home = home;
    this.scope = scope;
    this.identity = `chromium:${browser.id}`;
    this.#streams = browser.expiresHistory ? expiring : keeping;
    this.catalog = this.#streams.catalog;
    const { readers } = this.#streams;
    this.profiles = this.catalog.get(readers.profiles.name);
    this.historyItems = this.catalog.get(readers.historyItems.name);
    this.historyVisits = this.catalog.get(readers.historyVisits.name);
    this.downloads = this.catalog.get(readers.downloads.name);
    this.searchTerms = this.catalog.get(readers.searchTerms.name);
    this.bookmarks = this.catalog.get(readers.bookmarks.name);
    Object.freeze(this);
  }

  protected override open(streams: readonly Stream[]): Promise<ChromiumScan> {
    return ChromiumScan.open(
      this.browser,
      this.home,
      this.#stores(streams),
      this.scope,
    );
  }

  protected override readonly configErrors = [
    ChromiumHistoryUnavailableError,
    BookmarksUnavailableError,
  ];

  override coverage(_stream: Stream): ExtractionCoverage {
    return {
      description: `What ${this.browser.name} keeps on this Mac in each profile: its History, with the visits that sync brought from the user’s other devices while it ran, and its Bookmarks. ${this.browser.expiresHistory ? 'It removes visits after 90 days.' : 'It keeps every visit.'} An import’s profiles narrow every stream; its dates narrow visits.`,
      selection: this.scope,
    };
  }

  // The browser writes its History and Bookmarks only while it runs, and
  // sync brings the user's other devices into them only then. So while it is
  // closed, they stay as of its last write to them. Local State, which names
  // the profiles, changes only on this Mac.
  override async currentAsOf(stream: Stream): Promise<Date | null> {
    const { store } = this.#streams.readerOf(stream);
    if (store === 'profiles' || this.browser.running(this.home)) return null;
    const writes = await Promise.all(
      this.#files(store).map(async (path) =>
        store === 'history'
          ? chromiumHistoryLastWrite(path)
          : (await ChromiumBookmarks.stamp(path)).modifiedAt,
      ),
    );
    const times = writes.flatMap((date) => (date ? [date.getTime()] : []));
    return times.length === 0 ? null : new Date(Math.max(...times));
  }

  // Each store the streams read reports its own changes: a commit to any
  // History, a rewrite of any Bookmarks or of Local State, and a profile
  // that gains or loses one of them.
  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using versions = new DisposableStack();
    const histories = new Map<
      string,
      ReturnType<typeof chromiumHistoryVersion>
    >();
    const historyVersion = (path: string) => {
      let version = histories.get(path);
      if (version === undefined) {
        version = versions.use(chromiumHistoryVersion(path));
        histories.set(path, version);
      }
      return `${path}:${version.current}`;
    };
    const checks: Record<ChromiumStore, () => Promise<unknown>> = {
      history: async () => this.#files('history').map(historyVersion).join(),
      bookmarks: async () =>
        (
          await Promise.all(
            this.#files('bookmarks').map(async (path) =>
              String(await ChromiumBookmarks.stamp(path)),
            ),
          )
        ).join(),
      profiles: async () =>
        [
          String(await this.browser.localStateStamp(this.home)),
          ...this.#files('history'),
          ...this.#files('bookmarks'),
        ].join(),
    };
    const reads = new Map(
      [...this.#stores(streams)].map((store) => [store, checks[store]]),
    );
    for await (const changed of pollChanges(reads, {
      interval: pollIntervalMs,
      signal,
    }))
      yield streams.filter((stream) =>
        changed.has(this.#streams.readerOf(stream).store),
      );
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: ChromiumScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = this.#streams.readerOf(stream);
    yield* diffSnapshot(configuration, reader.read(stream, scan), state, {
      policy: reader.policy(scan),
      signal,
    });
  }

  #stores(streams: readonly Stream[]): Set<ChromiumStore> {
    return new Set(
      streams.map((stream) => this.#streams.readerOf(stream).store),
    );
  }

  // The History or Bookmarks file of each profile the import selects.
  #files(store: 'history' | 'bookmarks'): string[] {
    const file = storeFiles[store];
    return selectedProfiles(this.browser, this.home, file, this.scope).map(
      ({ path }) => join(path, file),
    );
  }
}
