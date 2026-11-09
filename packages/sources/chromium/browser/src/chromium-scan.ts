import { join } from 'node:path';

import {
  type ChromiumBookmark,
  ChromiumBookmarks,
} from '@eltjs/sdk-chromium-bookmarks';
import type { ChromiumBrowser } from '@eltjs/sdk-chromium-browser';
import {
  type ChromiumHistory,
  type HistoryDownload,
  type HistorySearchTerm,
  type HistoryUrl,
  type HistoryVisit,
  openChromiumHistory,
} from '@eltjs/sdk-chromium-history';
import {
  type ImportScope,
  selected,
  withinDates,
} from '@eltjs/source-apple-macos/import-scope';

// The files of a profile that the streams read: History, Bookmarks, and the
// browser's Local State, which names the profiles.
export type ChromiumStore = 'profiles' | 'history' | 'bookmarks';

export const storeFiles = {
  history: 'History',
  bookmarks: 'Bookmarks',
} as const;

// A row of one profile's store, with the profile it belongs to.
export type Profiled<T> = { readonly profileId: string; readonly row: T };

type ProfileHistory = {
  readonly profileId: string;
  readonly history: ChromiumHistory;
};

export type ChromiumProfileEntry = {
  readonly id: string;
  readonly name: string | null;
};

// The profile folders that hold a store the import selects, by folder name.
export function selectedProfiles(
  browser: ChromiumBrowser,
  home: string,
  file: string,
  scope: ImportScope,
) {
  return browser
    .profiles(home, file)
    .filter(({ folder }) => selected(scope.collectionIds, folder));
}

// Every profile's History as an import scope keeps it: the scope's profiles
// select every row, and its dates select visits. Rows are read as each
// stream iterates them, never held for the run.
class ScopedHistory {
  readonly #histories: readonly ProfileHistory[];
  readonly #scope: ImportScope;

  constructor(histories: readonly ProfileHistory[], scope: ImportScope) {
    this.#histories = histories;
    this.#scope = scope;
  }

  *urls(): Generator<Profiled<HistoryUrl>> {
    for (const { profileId, history } of this.#histories)
      for (const url of history.urls()) yield { profileId, row: url };
  }

  *visits(): Generator<Profiled<HistoryVisit>> {
    for (const { profileId, history } of this.#histories)
      for (const visit of history.visits())
        if (withinDates(this.#scope, toMilliseconds(visit.visitedAt)))
          yield { profileId, row: visit };
  }

  *downloads(): Generator<Profiled<HistoryDownload>> {
    for (const { profileId, history } of this.#histories)
      for (const download of history.downloads())
        yield { profileId, row: download };
  }

  *searchTerms(): Generator<Profiled<HistorySearchTerm>> {
    for (const { profileId, history } of this.#histories)
      for (const term of history.searchTerms()) yield { profileId, row: term };
  }
}

// A scope's bounds are instants to the millisecond; a visit's time to the
// microsecond compares with them by its millisecond, so that text order is
// time order.
const toMilliseconds = (instant: string | null) =>
  instant === null ? null : `${instant.slice(0, 23)}Z`;

type Readers = {
  profiles: readonly ChromiumProfileEntry[];
  history: ScopedHistory;
  bookmarks: readonly Profiled<ChromiumBookmark>[];
};

// A store's reader, or why it could not be opened.
type Opened<T> = { readonly reader: T } | { readonly error: unknown };
type OpenedStores = { [S in ChromiumStore]?: Opened<Readers[S]> };

// One run's read of the stores the selected streams need: each History a
// checked copy at the browser's last commit, each Bookmarks file read once.
// The stores are separate files, so streams of different stores need not
// agree, and a store that cannot be read fails only the streams that read
// it. Disposing it deletes the copies.
export class ChromiumScan implements AsyncDisposable {
  // When the run began, as an instant: the browser removed what expired
  // before it.
  readonly startedAt: string;
  readonly #resources: AsyncDisposableStack;
  readonly #stores: OpenedStores;

  private constructor(
    startedAt: string,
    resources: AsyncDisposableStack,
    stores: OpenedStores,
  ) {
    this.startedAt = startedAt;
    this.#resources = resources;
    this.#stores = stores;
  }

  static async open(
    browser: ChromiumBrowser,
    home: string,
    stores: ReadonlySet<ChromiumStore>,
    scope: ImportScope,
    started: Date,
  ): Promise<ChromiumScan> {
    const startedAt = started.toISOString();
    await using resources = new AsyncDisposableStack();
    const open = async <S extends ChromiumStore>(
      store: S,
      reader: () => Promise<Readers[S]> | Readers[S],
    ): Promise<Opened<Readers[S]> | undefined> => {
      if (!stores.has(store)) return undefined;
      try {
        return { reader: await reader() };
      } catch (error) {
        return { error };
      }
    };
    const opened: OpenedStores = {
      profiles: await open('profiles', () => {
        const names = browser.profileNames(home);
        const folders = new Set(
          Object.values(storeFiles).flatMap((file) =>
            selectedProfiles(browser, home, file, scope).map(
              ({ folder }) => folder,
            ),
          ),
        );
        return [...folders].map((id) => ({
          id,
          name: names.get(id) ?? null,
        }));
      }),
      history: await open('history', async () => {
        const histories: ProfileHistory[] = [];
        for (const { folder, path } of selectedProfiles(
          browser,
          home,
          storeFiles.history,
          scope,
        ))
          histories.push({
            profileId: folder,
            history: resources.use(
              await openChromiumHistory(join(path, storeFiles.history), {
                expires: browser.expiresHistory,
              }),
            ),
          });
        return new ScopedHistory(histories, scope);
      }),
      bookmarks: await open('bookmarks', () =>
        selectedProfiles(browser, home, storeFiles.bookmarks, scope).flatMap(
          ({ folder, path }) =>
            ChromiumBookmarks.read(
              join(path, storeFiles.bookmarks),
            ).bookmarks.map((row) => ({ profileId: folder, row })),
        ),
      ),
    };
    return new ChromiumScan(startedAt, resources.move(), opened);
  }

  get profiles(): readonly ChromiumProfileEntry[] {
    return this.#reader('profiles');
  }

  get history(): ScopedHistory {
    return this.#reader('history');
  }

  get bookmarks(): readonly Profiled<ChromiumBookmark>[] {
    return this.#reader('bookmarks');
  }

  #reader<S extends ChromiumStore>(store: S): Readers[S] {
    const opened: Opened<Readers[S]> | undefined = this.#stores[store];
    if (opened === undefined)
      throw new Error(`Chromium ${store} was not opened for this run`);
    if ('error' in opened) throw opened.error;
    return opened.reader;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.#resources.disposeAsync();
  }
}
