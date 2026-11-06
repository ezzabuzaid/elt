import { pollChanges } from '@zukhruf/async';
import { ClosedWorld } from '@zukhruf/snapshot-differential';

import {
  Catalog,
  type CopyConfiguration,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  type Stream,
  diffSnapshot,
} from '@workspace/elt';
import {
  type ClockLocation,
  type ClockSnapshot,
  ClockStore,
  type ClockStoreKind,
  StoreUnavailableError,
} from '@workspace/sdk-apple-clock/clock-store';
import { localAppleStoreCoverage } from '@workspace/source-apple-macos/local-apple-store-coverage';

import { AlarmsStream } from './streams/alarms-stream.ts';
import { CalendarReleasesStream } from './streams/calendar-releases-stream.ts';
import { MakeupDaysStream } from './streams/makeup-days-stream.ts';
import { ReportsStream } from './streams/reports-stream.ts';
import { SoundsStream } from './streams/sounds-stream.ts';
import { StopwatchLapsStream } from './streams/stopwatch-laps-stream.ts';
import { StopwatchesStream } from './streams/stopwatches-stream.ts';
import { TimerDurationsStream } from './streams/timer-durations-stream.ts';
import { TimersStream } from './streams/timers-stream.ts';
import { WorldClocksStream } from './streams/world-clocks-stream.ts';

const alarmsReader = new AlarmsStream();
const timersReader = new TimersStream();
const timerDurationsReader = new TimerDurationsStream();
const soundsReader = new SoundsStream();
const calendarReleasesReader = new CalendarReleasesStream();
const makeupDaysReader = new MakeupDaysStream();
const reportsReader = new ReportsStream();
const worldClocksReader = new WorldClocksStream();
const stopwatchesReader = new StopwatchesStream();
const stopwatchLapsReader = new StopwatchLapsStream();
const readers = [
  alarmsReader,
  timersReader,
  timerDurationsReader,
  soundsReader,
  calendarReleasesReader,
  makeupDaysReader,
  reportsReader,
  worldClocksReader,
  stopwatchesReader,
  stopwatchLapsReader,
];
const catalog = new Catalog(readers.map((reader) => reader.describe()));

function readerOf(stream: Stream) {
  const reader = readers.find((reader) => reader.name === stream.name);
  if (!reader) throw new Error(`Clock has no ${stream.name} stream`);
  return reader;
}

export class AppleClockSource extends Source<ClockSnapshot> {
  readonly identity = 'apple-clock';
  protected readonly catalog = catalog;
  readonly #store: ClockStore;
  readonly alarms = catalog.get(alarmsReader.name);
  readonly timers = catalog.get(timersReader.name);
  readonly timerDurations = catalog.get(timerDurationsReader.name);
  readonly sounds = catalog.get(soundsReader.name);
  readonly calendarReleases = catalog.get(calendarReleasesReader.name);
  readonly makeupDays = catalog.get(makeupDaysReader.name);
  readonly reports = catalog.get(reportsReader.name);
  readonly worldClocks = catalog.get(worldClocksReader.name);
  readonly stopwatches = catalog.get(stopwatchesReader.name);
  readonly stopwatchLaps = catalog.get(stopwatchLapsReader.name);
  constructor(location: ClockLocation) {
    super();
    this.#store = new ClockStore(location);
  }
  protected override open(streams: readonly Stream[]): Promise<ClockSnapshot> {
    return this.#store.open(
      new Set(streams.map((stream) => readerOf(stream).store)),
    );
  }
  protected override readonly configErrors = [StoreUnavailableError];
  override coverage() {
    return localAppleStoreCoverage;
  }

  override async currentAsOf() {
    return null;
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    snapshot: ClockSnapshot,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const records: Record<string, unknown>[] = readerOf(
      configuration.stream,
    ).read(snapshot);
    yield* diffSnapshot(configuration, records, state, {
      policy: new ClosedWorld(),
      signal,
    });
  }
  protected override async *observe({
    streams,
    signal,
    clock,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using resources = new DisposableStack();
    const reads = new Map<ClockStoreKind, () => Promise<string>>();
    for (const stream of streams) {
      const store = readerOf(stream).store;
      if (reads.has(store)) continue;
      const probe = resources.use(this.#store.version(store));
      reads.set(store, () => probe.current());
    }
    for await (const changed of pollChanges(reads, {
      interval: 1000,
      signal,
      clock,
    }))
      yield streams.filter((stream) => changed.has(readerOf(stream).store));
  }
}
