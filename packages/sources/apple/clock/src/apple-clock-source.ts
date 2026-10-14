import { setInterval } from 'node:timers/promises';

import {
  Catalog,
  type CopyConfiguration,
  type FailureType,
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
  ClockUnavailableError,
  type ClockVersion,
  clockLocation,
} from '@workspace/sdk-apple-clock/clock-store';
import { ClosedWorld } from '@workspace/snapshot-differential';
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
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly #store: ClockStore;
  readonly alarms = alarmsReader.describe();
  readonly timers = timersReader.describe();
  readonly timerDurations = timerDurationsReader.describe();
  readonly sounds = soundsReader.describe();
  readonly calendarReleases = calendarReleasesReader.describe();
  readonly makeupDays = makeupDaysReader.describe();
  readonly reports = reportsReader.describe();
  readonly worldClocks = worldClocksReader.describe();
  readonly stopwatches = stopwatchesReader.describe();
  readonly stopwatchLaps = stopwatchLapsReader.describe();
  constructor(location: ClockLocation = clockLocation) {
    super();
    this.#store = new ClockStore(location);
    this.identity = `apple-clock:${JSON.stringify([location.database, location.cities, location.stopwatches])}`;
  }
  protected override open(streams: readonly Stream[]): Promise<ClockSnapshot> {
    return this.#store.open(
      new Set(streams.map((stream) => readerOf(stream).store)),
    );
  }
  override failureType(error: unknown): FailureType {
    return error instanceof ClockUnavailableError ? 'config' : 'system';
  }
  override coverage() {
    return localAppleStoreCoverage;
  }
  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    snapshot: ClockSnapshot,
  ): AsyncGenerator<SourceMessage> {
    const records: Record<string, unknown>[] = readerOf(
      configuration.stream,
    ).read(snapshot);
    yield* configuration.syncMode === 'incremental'
      ? diffSnapshot(configuration.stream, records, state, {
          policy: new ClosedWorld(),
        })
      : records.map((data) => ({ stream: configuration.stream.name, data }));
  }
  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using resources = new DisposableStack();
    const probes = new Map<ClockStoreKind, ClockVersion>();
    const seen = new Map<ClockStoreKind, string>();
    for (const stream of streams) {
      const store = readerOf(stream).store;
      if (probes.has(store)) continue;
      const probe = resources.use(this.#store.version(store));
      probes.set(store, probe);
      seen.set(store, await probe.current());
    }
    yield streams;
    try {
      for await (const _ of setInterval(1000, undefined, { signal })) {
        const changed = new Set<ClockStoreKind>();
        for (const [store, probe] of probes) {
          const version = await probe.current();
          if (version === seen.get(store)) continue;
          seen.set(store, version);
          changed.add(store);
        }
        yield streams.filter((stream) => changed.has(readerOf(stream).store));
      }
    } catch (error) {
      if (!(
        signal.aborted &&
        error instanceof Error &&
        error.name === 'AbortError'
      ))
        throw error;
    }
  }
}
