import { setInterval } from 'node:timers/promises';

import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Catalog, Source } from '@workspace/elt';

import type { ActivityReader } from './activity-reader.ts';
import { ActivityScan, type ActivityStore } from './activity-scan.ts';
import {
  ActivityDatabaseVersion,
  type ActivityLocation,
  biomeDevices,
  biomeStreams,
  defaultActivityLocation,
} from './activity-store.ts';
import { BiomeStream, segmentFingerprint, segments } from './biome-stream.ts';
import { AppFocusStream } from './streams/app-focus-stream.ts';
import { AppIntentsStream } from './streams/app-intents-stream.ts';
import { AppMenuItemsStream } from './streams/app-menu-items-stream.ts';
import { BluetoothConnectionsStream } from './streams/bluetooth-connections-stream.ts';
import { DevicesStream } from './streams/devices-stream.ts';
import { DiscoverabilitySignalsStream } from './streams/discoverability-signals-stream.ts';
import { DisplayBacklightStream } from './streams/display-backlight-stream.ts';
import { DocumentInteractionsStream } from './streams/document-interactions-stream.ts';
import { FocusModesStream } from './streams/focus-modes-stream.ts';
import { FocusSuggestionsStream } from './streams/focus-suggestions-stream.ts';
import { KnowledgeIntentsStream } from './streams/knowledge-intents-stream.ts';
import { MediaUsageStream } from './streams/media-usage-stream.ts';
import { NotificationDeliveriesStream } from './streams/notification-deliveries-stream.ts';
import { NotificationUsageStream } from './streams/notification-usage-stream.ts';
import { NowPlayingStream } from './streams/now-playing-stream.ts';
import { SafariNavigationsStream } from './streams/safari-navigations-stream.ts';
import { ScreenTimeAppUsageStream } from './streams/screen-time-app-usage-stream.ts';
import { ScreenshotsStream } from './streams/screenshots-stream.ts';
import { WebUsageStream } from './streams/web-usage-stream.ts';

const readers = {
  appFocus: new AppFocusStream(),
  screenTimeAppUsage: new ScreenTimeAppUsageStream(),
  appMenuItems: new AppMenuItemsStream(),
  appIntents: new AppIntentsStream(),
  webUsage: new WebUsageStream(),
  safariNavigations: new SafariNavigationsStream(),
  documentInteractions: new DocumentInteractionsStream(),
  mediaUsage: new MediaUsageStream(),
  nowPlaying: new NowPlayingStream(),
  focusModes: new FocusModesStream(),
  focusSuggestions: new FocusSuggestionsStream(),
  notificationUsage: new NotificationUsageStream(),
  notificationDeliveries: new NotificationDeliveriesStream(),
  bluetoothConnections: new BluetoothConnectionsStream(),
  screenshots: new ScreenshotsStream(),
  knowledgeIntents: new KnowledgeIntentsStream(),
  displayBacklight: new DisplayBacklightStream(),
  discoverabilitySignals: new DiscoverabilitySignalsStream(),
  devices: new DevicesStream(),
} satisfies Record<string, ActivityReader>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);

const readersByName = new Map<string, ActivityReader>(
  Object.values(readers).map((reader) => [reader.name, reader]),
);
const readerOf = (stream: Stream): ActivityReader => {
  const reader = readersByName.get(stream.name);
  if (reader === undefined)
    throw new Error(`Apple Activity has no stream ${stream.name}`);
  return reader;
};

// Reads what macOS records about the user's activity: Biome's streams for this
// Mac and the devices it syncs with, the older knowledgeC store for what Biome
// lacks, and Biome's device list. macOS drops activity after each stream's
// maximum age; rows the source loaded stay.
export class AppleActivitySource extends Source<ActivityScan> {
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly appFocus = readers.appFocus.describe();
  readonly screenTimeAppUsage = readers.screenTimeAppUsage.describe();
  readonly appMenuItems = readers.appMenuItems.describe();
  readonly appIntents = readers.appIntents.describe();
  readonly webUsage = readers.webUsage.describe();
  readonly safariNavigations = readers.safariNavigations.describe();
  readonly documentInteractions = readers.documentInteractions.describe();
  readonly mediaUsage = readers.mediaUsage.describe();
  readonly nowPlaying = readers.nowPlaying.describe();
  readonly focusModes = readers.focusModes.describe();
  readonly focusSuggestions = readers.focusSuggestions.describe();
  readonly notificationUsage = readers.notificationUsage.describe();
  readonly notificationDeliveries = readers.notificationDeliveries.describe();
  readonly bluetoothConnections = readers.bluetoothConnections.describe();
  readonly screenshots = readers.screenshots.describe();
  readonly knowledgeIntents = readers.knowledgeIntents.describe();
  readonly displayBacklight = readers.displayBacklight.describe();
  readonly discoverabilitySignals = readers.discoverabilitySignals.describe();
  readonly devices = readers.devices.describe();

  readonly location: ActivityLocation;
  // How often a watch checks the stores. App focus records arrive with every
  // switch between apps, so a minute gathers them into one pass.
  readonly pollIntervalMs: number;

  constructor({
    biome = defaultActivityLocation.biome,
    knowledge = defaultActivityLocation.knowledge,
    pollIntervalMs = 60_000,
  }: { biome?: string; knowledge?: string; pollIntervalMs?: number } = {}) {
    super();
    this.location = Object.freeze({ biome, knowledge });
    this.pollIntervalMs = pollIntervalMs;
    this.identity = `apple-activity:${biome}:${knowledge}`;
    Object.freeze(this);
  }

  protected override open(streams: readonly Stream[]): Promise<ActivityScan> {
    return ActivityScan.open(
      this.location,
      new Set(streams.map((stream) => readerOf(stream).store)),
    );
  }

  override coverage(stream: Stream): ExtractionCoverage {
    const { retentionDays } = readerOf(stream);
    return {
      description:
        retentionDays === null
          ? 'Every device Biome lists now.'
          : `Every record macOS still keeps of this stream, up to ${retentionDays} days back, from this Mac and the devices it syncs with. Rows of records macOS has since dropped stay loaded; a deletion within that age deletes the row.`,
      selection: { retentionDays },
    };
  }

  // Biome writes into preallocated segment files in place, so neither their
  // size, their modification time nor FSEvents report a new record; each
  // segment's trailer does. Databases report commits through data_version.
  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using versions = new DisposableStack();
    const version = (path: string) => {
      const database = versions.use(new ActivityDatabaseVersion(path));
      return async () => String(database.current);
    };
    const probes = new Map<Stream, () => Promise<string>>();
    const databases = new Map<ActivityStore, () => Promise<string>>();
    for (const stream of streams) {
      const reader = readerOf(stream);
      if (reader instanceof BiomeStream) {
        const root = biomeStreams(this.location);
        probes.set(stream, async () =>
          (
            await Promise.all(
              (await segments(root, reader.biomeName)).map(
                async (segment) =>
                  `${segment.origin}/${segment.name}=${await segmentFingerprint(segment)}`,
              ),
            )
          ).join('|'),
        );
        continue;
      }
      if (!databases.has(reader.store))
        databases.set(
          reader.store,
          version(
            reader.store === 'knowledge'
              ? this.location.knowledge
              : biomeDevices(this.location),
          ),
        );
      const probe = databases.get(reader.store);
      if (probe !== undefined) probes.set(stream, probe);
    }
    const seen = new Map<Stream, string>();
    for (const [stream, probe] of probes) seen.set(stream, await probe());
    yield streams;
    try {
      for await (const _ of setInterval(this.pollIntervalMs, undefined, {
        signal,
      })) {
        const changed: Stream[] = [];
        for (const [stream, probe] of probes) {
          const current = await probe();
          if (current === seen.get(stream)) continue;
          seen.set(stream, current);
          changed.push(stream);
        }
        if (changed.length > 0) yield changed;
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) throw error;
    }
  }

  protected override extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: ActivityScan,
  ): AsyncIterable<SourceMessage> {
    return readerOf(configuration.stream).messages(configuration, state, scan);
  }
}
