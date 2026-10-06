import { setInterval } from 'node:timers/promises';

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
  readonly identity: string;
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
    this.identity = `apple-call-history:${path}`;
    Object.freeze(this);
  }

  protected override async open(): Promise<CallHistoryScan> {
    return new CallHistoryScan(this.#store.open(), this.scope);
  }

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using version = this.#store.version();
    let seen = version.current;
    yield streams;
    try {
      for await (const _ of setInterval(pollIntervalMs, undefined, {
        signal,
      })) {
        const current = version.current;
        if (current === seen) continue;
        seen = current;
        yield streams;
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) throw error;
    }
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: CallHistoryScan,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === undefined)
      throw new Error(`Apple Call History has no stream ${stream.name}`);
    const records = reader.read(scan);
    yield* configuration.syncMode === 'incremental'
      ? diffSnapshot(stream, records, state)
      : records.map((data) => ({ stream: stream.name, data }));
  }
}
