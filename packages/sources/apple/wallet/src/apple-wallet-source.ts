import { setInterval } from 'node:timers/promises';

import {
  Catalog,
  type CopyConfiguration,
  type ExtractionCoverage,
  type FailureType,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  type Stream,
  diffSnapshot,
} from '@workspace/elt';
import {
  WalletStore,
  WalletUnavailableError,
  walletStorePath,
} from '@workspace/sdk-apple-wallet';
import { localAppleStoreCoverage } from '@workspace/source-apple-macos/local-apple-store-coverage';

import type { WalletReader } from './apple-wallet-stream.ts';
import { PassBarcodesStream } from './streams/pass-barcodes-stream.ts';
import { PassBeaconsStream } from './streams/pass-beacons-stream.ts';
import { PassFieldsStream } from './streams/pass-fields-stream.ts';
import { PassImagesStream } from './streams/pass-images-stream.ts';
import { PassLocalizationsStream } from './streams/pass-localizations-stream.ts';
import { PassLocationsStream } from './streams/pass-locations-stream.ts';
import { PassRelevantDatesStream } from './streams/pass-relevant-dates-stream.ts';
import { PassesStream } from './streams/passes-stream.ts';
import { WalletScan } from './wallet-scan.ts';

const readers = {
  passes: new PassesStream(),
  passFields: new PassFieldsStream(),
  passBarcodes: new PassBarcodesStream(),
  passLocations: new PassLocationsStream(),
  passBeacons: new PassBeaconsStream(),
  passRelevantDates: new PassRelevantDatesStream(),
  passLocalizations: new PassLocalizationsStream(),
  passImages: new PassImagesStream(),
} satisfies Record<string, WalletReader>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);
const readersByName = new Map<string, WalletReader>(
  Object.values(readers).map((reader) => [reader.name, reader]),
);
// How often a watch checks the store for commits.
const pollIntervalMs = 1000;

// Reads the passes in this Mac's Wallet from the store passd keeps, without
// Wallet or PassKit, which show an app only the passes its issuer signed.
export class AppleWalletSource extends Source<WalletScan> {
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly passes = readers.passes.describe();
  readonly passFields = readers.passFields.describe();
  readonly passBarcodes = readers.passBarcodes.describe();
  readonly passLocations = readers.passLocations.describe();
  readonly passBeacons = readers.passBeacons.describe();
  readonly passRelevantDates = readers.passRelevantDates.describe();
  readonly passLocalizations = readers.passLocalizations.describe();
  readonly passImages = readers.passImages.describe();

  readonly #store: WalletStore;

  constructor({ directory = walletStorePath }: { directory?: string } = {}) {
    super();
    this.#store = new WalletStore(directory);
    this.identity = `apple-wallet:${directory}`;
    Object.freeze(this);
  }

  protected override async open(): Promise<WalletScan> {
    return new WalletScan(await this.#store.passes());
  }

  override failureType(error: unknown): FailureType {
    return error instanceof WalletUnavailableError ? 'config' : 'system';
  }

  override coverage(_stream: Stream): ExtractionCoverage {
    return localAppleStoreCoverage;
  }

  // passd commits to its database whenever a pass is added, updated,
  // archived or removed, and data_version cannot say which table a commit
  // touched, so each commit wakes every selected stream; the snapshot diff
  // writes nothing for the ones that did not change.
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
    scan: WalletScan,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === undefined)
      throw new TypeError(`Wallet has no stream ${stream.name}`);
    const records = reader.read(scan);
    const messages =
      configuration.syncMode === 'incremental'
        ? diffSnapshot(stream, records, state)
        : records.map((data) => ({ stream: stream.name, data }));
    for await (const message of messages) {
      if ('type' in message || configuration.fileReads.length === 0)
        yield message;
      else yield { ...message, file: reader.file(message.data) };
    }
  }
}
