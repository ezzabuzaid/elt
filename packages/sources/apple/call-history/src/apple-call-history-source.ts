import { pollChanges } from '@zukhruf/async';
import { ClosedWorld } from '@zukhruf/snapshot-differential';

import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Catalog, Source, diffSnapshot } from '@workspace/elt';
import {
  CallHistoryStore,
  CallHistoryUnavailableError,
  callHistoryStorePath,
} from '@workspace/sdk-apple-call-history';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import { localAppleStoreCoverage } from '@workspace/source-apple-macos/local-apple-store-coverage';

import type { CallHistoryReader } from './apple-call-history-stream.ts';
import { CallHistoryScan } from './call-history-scan.ts';
import { CallParticipantsStream } from './streams/call-participants-stream.ts';
import { CallTimersStream } from './streams/call-timers-stream.ts';
import { CallsStream } from './streams/calls-stream.ts';
import { EmergencyMediaItemsStream } from './streams/emergency-media-items-stream.ts';
import { SaintDavidsCountsStream } from './streams/saint-davids-counts-stream.ts';

const readers = {
  calls: new CallsStream(),
  callParticipants: new CallParticipantsStream(),
  callTimers: new CallTimersStream(),
  emergencyMediaItems: new EmergencyMediaItemsStream(),
  saintDavidsCounts: new SaintDavidsCountsStream(),
} satisfies Record<string, CallHistoryReader>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);
const readersByName = new Map<string, CallHistoryReader>(
  Object.values(readers).map((reader) => [reader.name, reader]),
);
// How often a watch checks the store for commits.
const pollIntervalMs = 1000;

// Reads this Mac's call history, the store callhistoryd keeps for Phone and
// FaceTime, without either app or the CallHistory framework.
export class AppleCallHistorySource extends Source<CallHistoryScan> {
  readonly identity = 'apple-call-history';
  protected readonly catalog = catalog;
  readonly calls = readers.calls.describe();
  readonly callParticipants = readers.callParticipants.describe();
  readonly callTimers = readers.callTimers.describe();
  readonly emergencyMediaItems = readers.emergencyMediaItems.describe();
  readonly saintDavidsCounts = readers.saintDavidsCounts.describe();

  readonly path: string;
  readonly scope: ImportScope;
  readonly #store: CallHistoryStore;

  constructor(path = callHistoryStorePath, scope: ImportScope = {}) {
    super();
    this.path = path;
    this.scope = scope;
    this.#store = new CallHistoryStore(path);
    Object.freeze(this);
  }

  protected override async open(): Promise<CallHistoryScan> {
    return new CallHistoryScan(this.#store.open(), this.scope);
  }

  protected override readonly configErrors = [CallHistoryUnavailableError];

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  override async currentAsOf() {
    return null;
  }

  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using version = this.#store.version();
    for await (const changed of pollChanges(
      new Map([['version', async () => version.current]]),
      { interval: pollIntervalMs, signal },
    ))
      yield changed.size > 0 ? streams : [];
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: CallHistoryScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === undefined)
      throw new Error(`Apple Call History has no stream ${stream.name}`);
    const records = reader.read(scan);
    yield* diffSnapshot(configuration, records, state, {
      policy: new ClosedWorld(),
      signal,
    });
  }
}
