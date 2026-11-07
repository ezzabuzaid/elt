import { type Check, Gauge } from '@zukhruf/async';

import {
  Catalog,
  type CopyConfiguration,
  type ExtractionCoverage,
  type FailureType,
  type Partition,
  type PipelineClock,
  Source,
  type SourceMessage,
  type Stream,
} from '@workspace/elt';
import {
  GoogleGrantRevokedError,
  type GoogleRequester,
  messageOf,
  statusOf,
} from '@workspace/google-auth';
import {
  GoogleHealthAccountNotLinkedError,
  GoogleHealthApi,
} from '@workspace/sdk-google-health';

import { AccountStream } from './account-stream.ts';
import { ChildStream } from './child-stream.ts';
import { GoogleHealthScan } from './google-health-scan.ts';
import type { GoogleHealthStream } from './google-health-stream.ts';
import { googleHealthStreams } from './google-health-streams.ts';
import { RollupStream } from './rollup-stream.ts';

export type GoogleHealthOptions = {
  readonly requester: GoogleRequester;
  // How many streams read at once; their API calls overlap.
  readonly streamConcurrency?: number;
  readonly pollIntervalMs?: number;
};

// The types whose newest point moves when a device or app syncs: steps and
// heart rate from Fitbit and Apple Health alike, and the logs a user writes.
const PROBED = ['steps', 'heart-rate', 'exercise', 'sleep', 'weight'] as const;

// How long the probe of one check may take. It makes its calls one after
// another: the paired devices, then the newest point of each probed type. The
// API retries a call up to four times and waits at most 60 seconds before
// each retry, so a call that gets an answer waits at most four minutes. A
// probe that takes longer than that for each of its calls is stuck.
const probeTimeoutMs = (1 + PROBED.length) * 4 * 60_000;

// The fingerprint of what moves when a device or app syncs, read over the
// network.
class Fingerprint extends Gauge<string> {
  readonly #read: (check: Check) => Promise<string>;

  constructor(read: (check: Check) => Promise<string>) {
    super();
    this.#read = read;
  }

  protected read(check: Check) {
    return this.#read(check);
  }
}

/**
 * Everything a Google account keeps in Google Health: each data type's points
 * from every source (Fitbit and Pixel devices, the Google Health app, and the
 * apps that write to it, Apple Health among them), the types Google answers
 * only as daily totals, and the account itself.
 */
export class GoogleHealthSource extends Source<GoogleHealthScan> {
  readonly identity = 'google-health';
  readonly pollIntervalMs: number;

  readonly #api: GoogleHealthApi;
  protected readonly catalog: Catalog;
  protected override readonly concurrency: number;
  // How each stream reads, by the stream it reads.
  readonly #readers: ReadonlyMap<Stream, GoogleHealthStream>;

  constructor(options: GoogleHealthOptions) {
    super();
    const { streamConcurrency = 4, pollIntervalMs = 15 * 60 * 1000 } = options;
    if (!Number.isSafeInteger(streamConcurrency) || streamConcurrency < 1)
      throw new TypeError(
        'streamConcurrency must be a whole number of at least one',
      );
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1)
      throw new TypeError(
        'pollIntervalMs must be a whole number of milliseconds of at least one',
      );
    this.#api = new GoogleHealthApi(options.requester);
    this.concurrency = streamConcurrency;
    this.pollIntervalMs = pollIntervalMs;
    this.#readers = new Map(
      googleHealthStreams().map((reader) => [reader.stream, reader]),
    );
    this.catalog = new Catalog([...this.#readers.keys()]);
    Object.freeze(this);
  }

  // Each read shares its fetches through one scan, and asks again.
  protected override async open(
    streams: readonly Stream[],
    signal: AbortSignal | undefined,
    states: { get(stream: string): unknown },
    clock: PipelineClock,
  ): Promise<GoogleHealthScan> {
    return new GoogleHealthScan(this.#api, clock);
  }

  override coverage(stream: Stream): ExtractionCoverage {
    const reader = this.#reader(stream);
    if (reader instanceof AccountStream)
      return {
        description: "The account's current answer, read whole each pass.",
        selection: {},
      };
    if (reader instanceof RollupStream)
      return {
        description:
          "Every day from the profile's membershipStartDate through today, read whole each pass.",
        selection: {},
      };
    return {
      description:
        "Every point of the data type Google Health holds, from every source, read whole each pass; a daily type from the profile's membershipStartDate.",
      selection: reader instanceof ChildStream ? { parent: reader.parent } : {},
    };
  }

  override async currentAsOf() {
    return null;
  }

  // Only the user can fix an account without a Google Health profile, a
  // grant Google no longer refreshes, or a grant without the data's scope.
  override failureType(error: unknown): FailureType {
    const status = statusOf(error);
    return error instanceof GoogleHealthAccountNotLinkedError ||
      GoogleGrantRevokedError.matches(error) ||
      status === 401 ||
      status === 403
      ? 'config'
      : 'system';
  }

  /**
   * Google Health notifies changes only to a public webhook, so a watch
   * polls. Each check reads the paired devices and the newest point of a few
   * types; when any of them moved, a device or app synced, and every stream
   * changed, since each one reloads whole. An edit to an old point alone
   * moves none of them, and loads with the next change.
   */
  override changeSignals(streams: readonly Stream[], clock: PipelineClock) {
    return [
      {
        gauge: new Fingerprint((check) => this.#fingerprint(check, clock)),
        streams,
        interval: this.pollIntervalMs,
        timeout: probeTimeoutMs,
      },
    ];
  }

  protected override extract(
    configuration: CopyConfiguration,
    _state: unknown,
    _partition: Partition | null,
    scan: GoogleHealthScan,
    signal: AbortSignal | undefined,
  ): AsyncIterable<SourceMessage> {
    return this.#reader(configuration.stream).extract(scan, signal);
  }

  #reader(stream: Stream): GoogleHealthStream {
    const reader = this.#readers.get(stream);
    if (reader === undefined)
      throw new TypeError(`Google Health has no stream ${stream.name}`);
    return reader;
  }

  async #fingerprint({ signal }: Check, clock: PipelineClock): Promise<string> {
    const marks = [
      await this.#probe(signal, () =>
        Array.fromAsync(
          this.#api.pairedDevices({ signal, clock }),
          (device) => [device.name, device.lastSyncTime],
        ),
      ),
    ];
    for (const type of PROBED)
      marks.push(
        await this.#probe(signal, () =>
          this.#api.newest(type, { signal, clock }),
        ),
      );
    return JSON.stringify(marks);
  }

  // A call that fails is part of the fingerprint, not the end of watching:
  // when it starts or stops failing, the extraction that follows reports it
  // or loads it.
  async #probe(
    signal: AbortSignal,
    call: () => Promise<unknown>,
  ): Promise<unknown> {
    signal.throwIfAborted();
    try {
      return await call();
    } catch (error) {
      if (signal.aborted) throw error;
      return { failed: messageOf(error) };
    }
  }
}
