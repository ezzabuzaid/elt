import { ChangeWatcher, Gauge } from '@zukhruf/async';

import type {
  CopyConfiguration,
  ExtractionCoverage,
  PipelineClock,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Catalog, Source } from '@workspace/elt';
import {
  BiomeStore,
  type BiomeStream,
  StoreUnavailableError,
} from '@workspace/sdk-apple-biome';
import { KnowledgeStore } from '@workspace/sdk-apple-knowledge';

import type { ActivityReader } from './activity-reader.ts';
import { type ActivityLocation, ActivityScan } from './activity-scan.ts';
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

// The fingerprints of one Biome stream's segments.
class BiomeStreamGauge extends Gauge<string> {
  readonly #store: BiomeStore;
  readonly #stream: BiomeStream<unknown>;

  constructor(store: BiomeStore, stream: BiomeStream<unknown>) {
    super();
    this.#store = store;
    this.#stream = stream;
  }

  protected read(): Promise<string> {
    return this.#store.version(this.#stream);
  }
}

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
  readonly identity = 'apple-activity';
  protected readonly catalog = catalog;
  readonly appFocus = catalog.get(readers.appFocus.name);
  readonly screenTimeAppUsage = catalog.get(readers.screenTimeAppUsage.name);
  readonly appMenuItems = catalog.get(readers.appMenuItems.name);
  readonly appIntents = catalog.get(readers.appIntents.name);
  readonly webUsage = catalog.get(readers.webUsage.name);
  readonly safariNavigations = catalog.get(readers.safariNavigations.name);
  readonly documentInteractions = catalog.get(
    readers.documentInteractions.name,
  );
  readonly mediaUsage = catalog.get(readers.mediaUsage.name);
  readonly nowPlaying = catalog.get(readers.nowPlaying.name);
  readonly focusModes = catalog.get(readers.focusModes.name);
  readonly focusSuggestions = catalog.get(readers.focusSuggestions.name);
  readonly notificationUsage = catalog.get(readers.notificationUsage.name);
  readonly notificationDeliveries = catalog.get(
    readers.notificationDeliveries.name,
  );
  readonly bluetoothConnections = catalog.get(
    readers.bluetoothConnections.name,
  );
  readonly screenshots = catalog.get(readers.screenshots.name);
  readonly knowledgeIntents = catalog.get(readers.knowledgeIntents.name);
  readonly displayBacklight = catalog.get(readers.displayBacklight.name);
  readonly discoverabilitySignals = catalog.get(
    readers.discoverabilitySignals.name,
  );
  readonly devices = catalog.get(readers.devices.name);

  readonly location: ActivityLocation;
  // How often a watch checks the stores. App focus records arrive with every
  // switch between apps, so a minute gathers them into one pass.
  readonly pollIntervalMs: number;

  constructor({
    biome,
    knowledge,
    pollIntervalMs = 60_000,
  }: {
    biome: string;
    knowledge: string;
    pollIntervalMs?: number;
  }) {
    super();
    this.location = Object.freeze({ biome, knowledge });
    this.pollIntervalMs = pollIntervalMs;
    Object.freeze(this);
  }

  // The run starts now on the clock of the pipeline.
  protected override open(
    streams: readonly Stream[],
    signal: AbortSignal | undefined,
    states: { get(stream: string): unknown },
    clock: PipelineClock,
  ): Promise<ActivityScan> {
    return ActivityScan.open(
      this.location,
      new Set(streams.map((stream) => readerOf(stream).store)),
      new Date(clock.Date.now()),
    );
  }

  protected override readonly configErrors = [StoreUnavailableError];

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

  override async currentAsOf() {
    return null;
  }

  // Biome writes into preallocated segment files in place, so neither their
  // size, their modification time nor FSEvents report a new record; each
  // segment's fingerprint does. Databases report commits through data_version.
  protected override async *observe({
    streams,
    signal,
    clock,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using versions = new DisposableStack();
    const biome = new BiomeStore(this.location.biome);
    const databases = {
      knowledge: () => new KnowledgeStore(this.location.knowledge).version(),
      devices: () => biome.syncVersion(),
    };
    // The streams of one database watch its one version.
    const watched = new Map<Stream, Gauge>();
    const opened = new Map<keyof typeof databases, Gauge>();
    for (const stream of streams) {
      const reader = readerOf(stream);
      if (reader.store === 'biome') {
        watched.set(stream, new BiomeStreamGauge(biome, reader.biome));
        continue;
      }
      let version = opened.get(reader.store);
      if (version === undefined) {
        version = versions.use(databases[reader.store]());
        opened.set(reader.store, version);
      }
      watched.set(stream, version);
    }
    const watcher = new ChangeWatcher(new Set(watched.values()), {
      interval: this.pollIntervalMs,
      // The reads are local, segment fingerprints and data_version: a check
      // that takes the whole interval is stuck.
      timeout: this.pollIntervalMs,
      clock,
    });
    for await (const outcomes of watcher.watch(signal)) {
      for (const outcome of outcomes.values())
        if (outcome.state === 'failed') throw outcome.error;
      yield [...watched]
        .filter(([, gauge]) => outcomes.get(gauge)?.state === 'changed')
        .map(([stream]) => stream);
    }
  }

  protected override extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: ActivityScan,
    signal: AbortSignal | undefined,
  ): AsyncIterable<SourceMessage> {
    return readerOf(configuration.stream).messages(
      configuration,
      state,
      scan,
      signal,
    );
  }
}
