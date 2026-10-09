import { setInterval } from 'node:timers/promises';

import type {
  CopyConfiguration,
  ExtractionCoverage,
  FailureType,
  SnapshotDiffOptions,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Catalog, Source, diffSnapshot, expiredAfter } from '@workspace/elt';
import {
  Safari,
  type SafariLocation,
  type SafariStore,
  SafariUnavailableError,
  type SafariVersion,
  safariContainer,
  safariDirectory,
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
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly historyItems = readers.historyItems.describe();
  readonly historyVisits = readers.historyVisits.describe();
  readonly historyTombstones = readers.historyTombstones.describe();
  readonly historyTags = readers.historyTags.describe();
  readonly historyItemTags = readers.historyItemTags.describe();
  readonly profiles = readers.profiles.describe();
  readonly profileStartPageSections =
    readers.profileStartPageSections.describe();
  readonly windows = readers.windows.describe();
  readonly windowProfiles = readers.windowProfiles.describe();
  readonly windowTabGroups = readers.windowTabGroups.describe();
  readonly tabGroups = readers.tabGroups.describe();
  readonly tabs = readers.tabs.describe();
  readonly tabHistoryEntries = readers.tabHistoryEntries.describe();
  readonly cloudTabDevices = readers.cloudTabDevices.describe();
  readonly cloudTabs = readers.cloudTabs.describe();
  readonly cloudTabPositions = readers.cloudTabPositions.describe();
  readonly cloudTabCloseRequests = readers.cloudTabCloseRequests.describe();
  readonly bookmarks = readers.bookmarks.describe();
  readonly readingListItems = readers.readingListItems.describe();
  readonly closedWindows = readers.closedWindows.describe();
  readonly closedWindowActiveTabs = readers.closedWindowActiveTabs.describe();
  readonly closedTabs = readers.closedTabs.describe();
  readonly downloads = readers.downloads.describe();

  readonly location: SafariLocation;
  readonly scope: ImportScope;
  readonly #safari: Safari;

  constructor({
    directory = safariDirectory,
    container = safariContainer,
    scope = {},
  }: {
    directory?: string;
    container?: string;
    scope?: ImportScope;
  } = {}) {
    super();
    this.location = Object.freeze({ directory, container });
    this.scope = scope;
    this.#safari = new Safari(this.location);
    this.identity = `apple-safari:${directory}:${container}`;
    Object.freeze(this);
  }

  protected override open(streams: readonly Stream[]): Promise<SafariScan> {
    return SafariScan.open(
      this.#safari,
      new Set(streams.map((stream) => readerOf(stream).store)),
      this.scope,
    );
  }

  override failureType(error: unknown): FailureType {
    return error instanceof SafariUnavailableError ? 'config' : 'system';
  }

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  // Each store the streams read reports its own changes.
  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using versions = new DisposableStack();
    const probes = new Map<SafariStore, SafariVersion>(
      [...new Set(streams.map((stream) => readerOf(stream).store))].map(
        (store) => [store, versions.use(this.#safari.version(store))],
      ),
    );
    const seen = new Map<SafariStore, string>();
    for (const [store, probe] of probes) seen.set(store, await probe.current());
    yield streams;
    try {
      for await (const _ of setInterval(pollIntervalMs, undefined, {
        signal,
      })) {
        const changed = new Set<SafariStore>();
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
    scan: SafariScan,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readerOf(stream);
    const records = await reader.read(scan);
    const messages =
      configuration.syncMode === 'incremental'
        ? diffSnapshot(stream, records, state, coveredBy(reader.horizon(scan)))
        : records.map((data) => ({ stream: stream.name, data }));
    for await (const message of messages) {
      if ('type' in message || configuration.fileReads.length === 0)
        yield message;
      else yield { ...message, file: reader.file(message.data, scan) };
    }
  }
}

// A stream that expires covers what vanished after its horizon; any other
// stream covers every record.
function coveredBy(horizon: string | undefined): SnapshotDiffOptions {
  return horizon === undefined ? {} : { covers: expiredAfter(horizon) };
}
