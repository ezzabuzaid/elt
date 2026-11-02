import { pollChanges } from '@zukhruf/async';
import {
  ClosedWorld,
  type DeletionPolicy,
  Retention,
} from '@zukhruf/snapshot-differential';

import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Catalog, Source, diffSnapshot } from '@workspace/elt';
import {
  Safari,
  type SafariLocation,
  type SafariStore,
  SafariUnavailableError,
  safariRunning,
} from '@workspace/sdk-apple-safari';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import { localAppleStoreCoverage } from '@workspace/source-apple-macos/local-apple-store-coverage';

import { SafariScan } from './safari-scan.ts';
import type { SafariReader } from './safari-stream.ts';
import { BookmarksStream } from './streams/bookmarks-stream.ts';
import { ClosedTabsStream } from './streams/closed-tabs-stream.ts';
import { ClosedWindowActiveTabsStream } from './streams/closed-window-active-tabs-stream.ts';
import { ClosedWindowsStream } from './streams/closed-windows-stream.ts';
import { CloudTabCloseRequestsStream } from './streams/cloud-tab-close-requests-stream.ts';
import { CloudTabDevicesStream } from './streams/cloud-tab-devices-stream.ts';
import { CloudTabPositionsStream } from './streams/cloud-tab-positions-stream.ts';
import { CloudTabsStream } from './streams/cloud-tabs-stream.ts';
import { DownloadsStream } from './streams/downloads-stream.ts';
import { HistoryItemTagsStream } from './streams/history-item-tags-stream.ts';
import { HistoryItemsStream } from './streams/history-items-stream.ts';
import { HistoryTagsStream } from './streams/history-tags-stream.ts';
import { HistoryTombstonesStream } from './streams/history-tombstones-stream.ts';
import { HistoryVisitsStream } from './streams/history-visits-stream.ts';
import { ProfileStartPageSectionsStream } from './streams/profile-start-page-sections-stream.ts';
import { ProfilesStream } from './streams/profiles-stream.ts';
import { ReadingListItemsStream } from './streams/reading-list-items-stream.ts';
import { TabGroupsStream } from './streams/tab-groups-stream.ts';
import { TabHistoryEntriesStream } from './streams/tab-history-entries-stream.ts';
import { TabsStream } from './streams/tabs-stream.ts';
import { WindowProfilesStream } from './streams/window-profiles-stream.ts';
import { WindowTabGroupsStream } from './streams/window-tab-groups-stream.ts';
import { WindowsStream } from './streams/windows-stream.ts';

const readers = {
  historyItems: new HistoryItemsStream(),
  historyVisits: new HistoryVisitsStream(),
  historyTombstones: new HistoryTombstonesStream(),
  historyTags: new HistoryTagsStream(),
  historyItemTags: new HistoryItemTagsStream(),
  profiles: new ProfilesStream(),
  profileStartPageSections: new ProfileStartPageSectionsStream(),
  windows: new WindowsStream(),
  windowProfiles: new WindowProfilesStream(),
  windowTabGroups: new WindowTabGroupsStream(),
  tabGroups: new TabGroupsStream(),
  tabs: new TabsStream(),
  tabHistoryEntries: new TabHistoryEntriesStream(),
  cloudTabDevices: new CloudTabDevicesStream(),
  cloudTabs: new CloudTabsStream(),
  cloudTabPositions: new CloudTabPositionsStream(),
  cloudTabCloseRequests: new CloudTabCloseRequestsStream(),
  bookmarks: new BookmarksStream(),
  readingListItems: new ReadingListItemsStream(),
  closedWindows: new ClosedWindowsStream(),
  closedWindowActiveTabs: new ClosedWindowActiveTabsStream(),
  closedTabs: new ClosedTabsStream(),
  downloads: new DownloadsStream(),
} satisfies Record<string, SafariReader>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);
const readersByName = new Map<string, SafariReader>(
  Object.values(readers).map((reader) => [reader.name, reader]),
);

function readerOf(stream: Stream): SafariReader {
  const reader = readersByName.get(stream.name);
  if (reader === undefined)
    throw new TypeError(`Safari has no ${stream.name} stream`);
  return reader;
}

// How often a watch checks the stores for changes.
const pollIntervalMs = 1000;

// Reads Safari's own stores, so Safari need not run to export. Only Safari
// fetches history and tabs from the user's other devices, so what they
// contribute is what Safari last fetched while it ran.
export class AppleSafariSource extends Source<SafariScan> {
  readonly identity = 'apple-safari';
  protected readonly catalog = catalog;
  readonly historyItems = catalog.get(readers.historyItems.name);
  readonly historyVisits = catalog.get(readers.historyVisits.name);
  readonly historyTombstones = catalog.get(readers.historyTombstones.name);
  readonly historyTags = catalog.get(readers.historyTags.name);
  readonly historyItemTags = catalog.get(readers.historyItemTags.name);
  readonly profiles = catalog.get(readers.profiles.name);
  readonly profileStartPageSections = catalog.get(
    readers.profileStartPageSections.name,
  );
  readonly windows = catalog.get(readers.windows.name);
  readonly windowProfiles = catalog.get(readers.windowProfiles.name);
  readonly windowTabGroups = catalog.get(readers.windowTabGroups.name);
  readonly tabGroups = catalog.get(readers.tabGroups.name);
  readonly tabs = catalog.get(readers.tabs.name);
  readonly tabHistoryEntries = catalog.get(readers.tabHistoryEntries.name);
  readonly cloudTabDevices = catalog.get(readers.cloudTabDevices.name);
  readonly cloudTabs = catalog.get(readers.cloudTabs.name);
  readonly cloudTabPositions = catalog.get(readers.cloudTabPositions.name);
  readonly cloudTabCloseRequests = catalog.get(
    readers.cloudTabCloseRequests.name,
  );
  readonly bookmarks = catalog.get(readers.bookmarks.name);
  readonly readingListItems = catalog.get(readers.readingListItems.name);
  readonly closedWindows = catalog.get(readers.closedWindows.name);
  readonly closedWindowActiveTabs = catalog.get(
    readers.closedWindowActiveTabs.name,
  );
  readonly closedTabs = catalog.get(readers.closedTabs.name);
  readonly downloads = catalog.get(readers.downloads.name);

  readonly location: SafariLocation;
  readonly scope: ImportScope;
  readonly #safari: Safari;

  constructor({
    directory,
    container,
    scope = {},
  }: {
    directory: string;
    container: string;
    scope?: ImportScope;
  }) {
    super();
    this.location = Object.freeze({ directory, container });
    this.scope = scope;
    this.#safari = new Safari(this.location);
    Object.freeze(this);
  }

  protected override open(streams: readonly Stream[]): Promise<SafariScan> {
    return SafariScan.open(
      this.#safari,
      new Set(streams.map((stream) => readerOf(stream).store)),
      this.scope,
    );
  }

  protected override readonly configErrors = [SafariUnavailableError];

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  // Safari syncs history and cloud tabs from iCloud only while it runs, so
  // while it is closed those stores stay as of its last write to them. Tab
  // groups and bookmarks sync through helpers that run without Safari, and
  // closed tabs and downloads hold only what happens on this Mac.
  override async currentAsOf(stream: Stream): Promise<Date | null> {
    const { store } = readerOf(stream);
    if (store !== 'history' && store !== 'cloudTabs') return null;
    return (await safariRunning()) ? null : this.#safari.lastWrite(store);
  }

  // Each store the streams read reports its own changes.
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
          const probe = versions.use(this.#safari.version(store));
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
    scan: SafariScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readerOf(stream);
    const records = reader.read(scan);
    const messages = diffSnapshot(configuration, records, state, {
      policy: policyFor(reader.horizon(scan)),
      signal,
    });
    for await (const message of messages) {
      if ('type' in message || configuration.fileReads.length === 0)
        yield message;
      else yield { ...message, file: reader.file(message.data, scan) };
    }
  }
}

// A stream that expires keeps records from its horizon on; any other lists
// every record.
function policyFor(horizon: string | undefined): DeletionPolicy {
  return horizon === undefined ? new ClosedWorld() : new Retention(horizon);
}
