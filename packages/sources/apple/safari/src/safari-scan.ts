import type {
  Bookmarks,
  ClosedTab,
  ClosedWindow,
  CloudTab,
  CloudTabCloseRequest,
  CloudTabDevice,
  CloudTabs,
  Download,
  HistoryItem,
  HistoryItemTag,
  HistoryTag,
  HistoryTombstone,
  HistoryVisit,
  ProfileHistory,
  Safari,
  SafariProfile,
  SafariStore,
  SafariTabs,
  SafariWindow,
  Tab,
  TabGroup,
  WindowProfile,
  WindowTabGroup,
} from '@workspace/sdk-apple-safari';
import {
  type ImportScope,
  selected,
  withinDates,
} from '@workspace/source-apple-macos/import-scope';

import { iso } from './safari-stream.ts';

const dayMs = 86_400_000;
// Manually's 365000 days reach back past the first year a timestamp can name.
const firstYear = Date.parse('0001-01-01T00:00:00.000Z');
// Safari prunes by its own clock before a read sees the result; an hour inside
// the limit absorbs a daylight-saving shift.
const marginMs = 3_600_000;

// The instant Safari keeps visits from at startedAt.
const historyHorizon = (days: number, startedAt: Date) =>
  new Date(
    Math.max(firstYear, startedAt.getTime() - days * dayMs + marginMs),
  ).toISOString();

// A row of one profile's history, with the profile it belongs to.
export type Profiled<T> = { readonly profileId: string; readonly row: T };

// One profile's history as an import scope keeps it: the scope's profiles and
// dates select visits, and items, tags and tag links follow the visits kept.
class ProfileRecords {
  readonly profileId: string;
  readonly #history: ProfileHistory;
  readonly #scope: ImportScope;
  #visits?: HistoryVisit[];
  #items?: HistoryItem[];
  #itemTags?: HistoryItemTag[];
  #tags?: HistoryTag[];

  constructor(history: ProfileHistory, scope: ImportScope) {
    this.profileId = history.profileId;
    this.#history = history;
    this.#scope = scope;
  }

  get #included(): boolean {
    return selected(this.#scope.collectionIds, this.profileId);
  }

  get #dated(): boolean {
    return this.#scope.startAt !== undefined || this.#scope.endAt !== undefined;
  }

  get visits(): HistoryVisit[] {
    this.#visits ??= this.#included
      ? this.#history
          .visits()
          .filter((visit) => withinDates(this.#scope, iso(visit.visitedAt)))
      : [];
    return this.#visits;
  }

  get items(): HistoryItem[] {
    if (this.#items !== undefined) return this.#items;
    const visited = new Set(this.visits.map((visit) => visit.itemId));
    this.#items = this.#included
      ? this.#history
          .items()
          .filter((item) => !this.#dated || visited.has(item.id))
      : [];
    return this.#items;
  }

  get itemTags(): HistoryItemTag[] {
    if (this.#itemTags !== undefined) return this.#itemTags;
    const items = new Set(this.items.map((item) => item.id));
    this.#itemTags = this.#included
      ? this.#history.itemTags().filter((link) => items.has(link.itemId))
      : [];
    return this.#itemTags;
  }

  get tags(): HistoryTag[] {
    if (this.#tags !== undefined) return this.#tags;
    const linked = new Set(this.itemTags.map((link) => link.tagId));
    this.#tags = this.#included
      ? this.#history.tags().filter((tag) => !this.#dated || linked.has(tag.id))
      : [];
    return this.#tags;
  }

  // Tombstones record deletions to sync to other devices, whatever their date.
  get tombstones(): HistoryTombstone[] {
    return this.#included ? this.#history.tombstones() : [];
  }
}

// Safari history as one run reads it, with the instant Safari keeps visits
// from.
type ScopedHistory = {
  readonly profiles: readonly ProfileRecords[];
  readonly horizon: string;
};

// SafariTabs.db as an import scope keeps it: the scope's profiles select
// profiles, windows, groups and tabs. Folders of no profile, such as pinned
// tabs, are shared by every profile, so any profile's scope keeps them.
class ScopedTabs {
  readonly #tabs: SafariTabs;
  readonly #scope: ImportScope;
  #profiles?: SafariProfile[];
  #windows?: SafariWindow[];
  #tabGroups?: TabGroup[];
  #tabList?: Tab[];

  constructor(tabs: SafariTabs, scope: ImportScope) {
    this.#tabs = tabs;
    this.#scope = scope;
  }

  #selected(profileId: string | null): boolean {
    return selected(this.#scope.collectionIds, profileId);
  }

  get profiles(): SafariProfile[] {
    this.#profiles ??= this.#tabs
      .profiles()
      .filter((profile) => this.#selected(profile.id));
    return this.#profiles;
  }

  get windows(): SafariWindow[] {
    this.#windows ??= this.#tabs
      .windows()
      .filter((window) => this.#selected(window.profileId));
    return this.#windows;
  }

  get windowProfiles(): WindowProfile[] {
    return this.#tabs
      .windowProfiles()
      .filter((link) => this.#selected(link.windowProfileId));
  }

  get windowTabGroups(): WindowTabGroup[] {
    return this.#tabs
      .windowTabGroups()
      .filter((link) => this.#selected(link.windowProfileId));
  }

  get tabGroups(): TabGroup[] {
    this.#tabGroups ??= this.#tabs
      .tabGroups()
      .filter(
        (group) => group.profileId === null || this.#selected(group.profileId),
      );
    return this.#tabGroups;
  }

  get tabs(): Tab[] {
    this.#tabList ??= this.#tabs
      .tabs()
      .filter((tab) => this.#selected(tab.profileId));
    return this.#tabList;
  }
}

// CloudTabs.db as one run reads it; its tabs serve both the tabs and their
// positions.
class CloudTabsRecords {
  readonly #cloudTabs: CloudTabs;
  #tabs?: CloudTab[];

  constructor(cloudTabs: CloudTabs) {
    this.#cloudTabs = cloudTabs;
  }

  get devices(): CloudTabDevice[] {
    return this.#cloudTabs.devices();
  }

  get tabs(): CloudTab[] {
    this.#tabs ??= this.#cloudTabs.tabs();
    return this.#tabs;
  }

  get closeRequests(): CloudTabCloseRequest[] {
    return this.#cloudTabs.closeRequests();
  }
}

type ClosedEntries = {
  readonly windows: ClosedWindow[];
  readonly tabs: ClosedTab[];
};

type Readers = {
  history: ScopedHistory;
  tabs: ScopedTabs;
  cloudTabs: CloudTabsRecords;
  bookmarks: Bookmarks;
  closedTabs: ClosedEntries;
  downloads: Download[];
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
    safari: Safari,
    stores: ReadonlySet<SafariStore>,
    scope: ImportScope,
  ): Promise<SafariScan> {
    const startedAt = new Date();
    await using resources = new AsyncDisposableStack();
    const open = async <S extends SafariStore>(
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
      history: await open('history', async () => {
        const history = resources.use(safari.history());
        return {
          profiles: history.profiles.map(
            (profile) => new ProfileRecords(profile, scope),
          ),
          horizon: historyHorizon(await safari.historyAgeInDays(), startedAt),
        };
      }),
      tabs: await open(
        'tabs',
        () => new ScopedTabs(resources.use(safari.tabs()), scope),
      ),
      cloudTabs: await open(
        'cloudTabs',
        () => new CloudTabsRecords(resources.use(safari.cloudTabs())),
      ),
      bookmarks: await open('bookmarks', () => safari.bookmarks()),
      closedTabs: await open('closedTabs', async () =>
        (await safari.recentlyClosed()).closed((profileId) =>
          selected(scope.collectionIds, profileId),
        ),
      ),
      downloads: await open('downloads', async () =>
        (await safari.downloads()).downloads.filter((download) =>
          selected(scope.collectionIds, download.profileId),
        ),
      ),
    };
    return new SafariScan(resources.move(), opened);
  }

  get history(): ScopedHistory {
    return this.#reader('history');
  }

  get tabs(): ScopedTabs {
    return this.#reader('tabs');
  }

  get downloads(): Download[] {
    return this.#reader('downloads');
  }

  get cloudTabs(): CloudTabsRecords {
    return this.#reader('cloudTabs');
  }

  get bookmarks(): Bookmarks {
    return this.#reader('bookmarks');
  }

  get closedTabs(): ClosedEntries {
    return this.#reader('closedTabs');
  }

  #reader<S extends SafariStore>(store: S): Readers[S] {
    const opened: Opened<Readers[S]> | undefined = this.#stores[store];
    if (opened === undefined)
      throw new Error(`Safari ${store} was not opened for this run`);
    if ('error' in opened) throw opened.error;
    return opened.reader;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.#resources.disposeAsync();
  }
}
