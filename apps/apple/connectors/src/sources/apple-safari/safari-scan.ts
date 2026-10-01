import { join } from 'node:path';
import {
  readSafariPlist,
  SafariDatabase,
} from '../../platform/macos/safari-store.ts';
import type { ImportScope } from '../import-scope.ts';
import { BookmarksReader } from './bookmarks-reader.ts';
import { ClosedTabsReader } from './closed-tabs-reader.ts';
import { CloudTabsReader, cloudTabsColumns } from './cloud-tabs-reader.ts';
import { DownloadsReader } from './downloads-reader.ts';
import { HistoryReader, historyColumns } from './history-reader.ts';
import { defaultProfile } from './safari-values.ts';
import { TabsReader, tabsColumns } from './tabs-reader.ts';

// Where Safari keeps each kind of data: databases it commits to, and property
// lists it rewrites whole.
export type SafariStore =
  | 'history'
  | 'tabs'
  | 'cloudTabs'
  | 'bookmarks'
  | 'closedTabs'
  | 'downloads';

export type SafariLocation = {
  // ~/Library/Safari: History.db and the property lists.
  readonly directory: string;
  // Safari's container: SafariTabs.db, CloudTabs.db and each other profile's
  // History.db.
  readonly container: string;
};

// The file each store keeps; history has one more History.db per profile.
export const storeFiles = ({ directory, container }: SafariLocation) =>
  ({
    history: join(directory, 'History.db'),
    tabs: join(container, 'SafariTabs.db'),
    cloudTabs: join(container, 'CloudTabs.db'),
    bookmarks: join(directory, 'Bookmarks.plist'),
    closedTabs: join(directory, 'RecentlyClosedTabs.plist'),
    downloads: join(directory, 'Downloads.plist'),
  }) satisfies Record<SafariStore, string>;

// The default profile keeps its history in ~/Library/Safari; every other
// profile in the container's Profiles folder named by its server_id.
export const profileHistory = (
  { directory, container }: SafariLocation,
  serverId: string,
) =>
  serverId === defaultProfile
    ? join(directory, 'History.db')
    : join(container, 'Profiles', serverId, 'History.db');

export const databaseStores = new Set<SafariStore>([
  'history',
  'tabs',
  'cloudTabs',
]);

type Readers = {
  history: HistoryReader[];
  tabs: TabsReader;
  cloudTabs: CloudTabsReader;
  bookmarks: BookmarksReader;
  closedTabs: ClosedTabsReader;
  downloads: DownloadsReader;
};

// A store's reader, or why it could not be opened.
type Opened<T> = { readonly reader: T } | { readonly error: unknown };
type OpenedStores = { [S in SafariStore]?: Opened<Readers[S]> };

// One run's read of the Safari stores the selected streams need: each
// database pinned to one read transaction, each property list read once.
// Stores are separate files, so streams of different stores need not agree,
// and a store that cannot be opened fails only the streams that read it.
// Disposing it ends the read transactions.
export class SafariScan implements AsyncDisposable {
  readonly #resources: AsyncDisposableStack;
  readonly #stores: OpenedStores;

  private constructor(resources: AsyncDisposableStack, stores: OpenedStores) {
    this.#resources = resources;
    this.#stores = stores;
  }

  static async open(
    location: SafariLocation,
    stores: ReadonlySet<SafariStore>,
    scope: ImportScope,
  ): Promise<SafariScan> {
    const files = storeFiles(location);
    await using resources = new AsyncDisposableStack();
    const database = async (
      path: string,
      columns: Readonly<Record<string, readonly string[]>>,
    ) => resources.use(await SafariDatabase.open(path, columns));
    const open = async <S extends SafariStore>(
      store: S,
      reader: () => Promise<Readers[S]>,
    ): Promise<Opened<Readers[S]> | undefined> => {
      if (!stores.has(store)) return undefined;
      try {
        return { reader: await reader() };
      } catch (error) {
        return { error };
      }
    };
    const opened: OpenedStores = {
      // Each profile's History.db, pinned on its own; SafariTabs.db lists them.
      history: await open('history', async () => {
        const profiles = new TabsReader(
          await database(files.tabs, tabsColumns),
          {},
        ).allProfiles;
        const readers: HistoryReader[] = [];
        for (const profile of profiles)
          readers.push(
            new HistoryReader(
              await database(
                profileHistory(location, profile.server_id as string),
                historyColumns,
              ),
              profile.external_uuid as string,
              scope,
            ),
          );
        return readers;
      }),
      tabs: await open(
        'tabs',
        async () =>
          new TabsReader(await database(files.tabs, tabsColumns), scope),
      ),
      cloudTabs: await open(
        'cloudTabs',
        async () =>
          new CloudTabsReader(
            await database(files.cloudTabs, cloudTabsColumns),
          ),
      ),
      bookmarks: await open(
        'bookmarks',
        async () => new BookmarksReader(await readSafariPlist(files.bookmarks)),
      ),
      closedTabs: await open(
        'closedTabs',
        async () =>
          new ClosedTabsReader(await readSafariPlist(files.closedTabs), scope),
      ),
      downloads: await open(
        'downloads',
        async () =>
          new DownloadsReader(await readSafariPlist(files.downloads), scope),
      ),
    };
    return new SafariScan(resources.move(), opened);
  }

  get history(): HistoryReader[] {
    return this.#reader('history');
  }

  get tabs(): TabsReader {
    return this.#reader('tabs');
  }

  get downloads(): DownloadsReader {
    return this.#reader('downloads');
  }

  get cloudTabs(): CloudTabsReader {
    return this.#reader('cloudTabs');
  }

  get bookmarks(): BookmarksReader {
    return this.#reader('bookmarks');
  }

  get closedTabs(): ClosedTabsReader {
    return this.#reader('closedTabs');
  }

  #reader<S extends SafariStore>(store: S): Readers[S] {
    const opened = this.#stores[store] as Opened<Readers[S]> | undefined;
    if (opened === undefined)
      throw new Error(`Safari ${store} was not opened for this run`);
    if ('error' in opened) throw opened.error;
    return opened.reader;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.#resources.disposeAsync();
  }
}
