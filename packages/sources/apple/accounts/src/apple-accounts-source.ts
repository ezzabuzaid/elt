import { setInterval } from 'node:timers/promises';

import type {
  CopyConfiguration,
  ExtractionCoverage,
  FailureType,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Catalog, Source, diffSnapshot } from '@workspace/elt';
import {
  AccountsStore,
  AccountsUnavailableError,
  accountsStorePath,
} from '@workspace/sdk-apple-accounts';
import { localAppleStoreCoverage } from '@workspace/source-apple-macos/local-apple-store-coverage';

import { AccountsScan } from './accounts-scan.ts';
import type { AccountsReader } from './apple-accounts-stream.ts';
import { AccessOptionKeysStream } from './streams/access-option-keys-stream.ts';
import { AccountDataclassesStream } from './streams/account-dataclasses-stream.ts';
import { AccountPropertiesStream } from './streams/account-properties-stream.ts';
import { AccountTypesStream } from './streams/account-types-stream.ts';
import { AccountsStream } from './streams/accounts-stream.ts';
import { AuthorizationsStream } from './streams/authorizations-stream.ts';
import { CredentialItemsStream } from './streams/credential-items-stream.ts';
import { DataclassesStream } from './streams/dataclasses-stream.ts';

const readers = {
  accounts: new AccountsStream(),
  accountProperties: new AccountPropertiesStream(),
  accountDataclasses: new AccountDataclassesStream(),
  accountTypes: new AccountTypesStream(),
  dataclasses: new DataclassesStream(),
  accessOptionKeys: new AccessOptionKeysStream(),
  authorizations: new AuthorizationsStream(),
  credentialItems: new CredentialItemsStream(),
} satisfies Record<string, AccountsReader>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);
const readersByName = new Map<string, AccountsReader>(
  Object.values(readers).map((reader) => [reader.name, reader]),
);
// How often a watch checks the store for commits.
const pollIntervalMs = 1000;

// Reads the system Accounts store, where macOS keeps every account its apps
// sync through, without the Accounts framework or any app.
export class AppleAccountsSource extends Source<AccountsScan> {
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly accounts = readers.accounts.describe();
  readonly accountProperties = readers.accountProperties.describe();
  readonly accountDataclasses = readers.accountDataclasses.describe();
  readonly accountTypes = readers.accountTypes.describe();
  readonly dataclasses = readers.dataclasses.describe();
  readonly accessOptionKeys = readers.accessOptionKeys.describe();
  readonly authorizations = readers.authorizations.describe();
  readonly credentialItems = readers.credentialItems.describe();

  readonly path: string;
  readonly #store: AccountsStore;

  constructor({ path = accountsStorePath }: { path?: string } = {}) {
    super();
    this.path = path;
    this.#store = new AccountsStore(path);
    this.identity = `apple-accounts:${path}`;
    Object.freeze(this);
  }

  protected override async open(): Promise<AccountsScan> {
    return new AccountsScan(this.#store.open());
  }

  override failureType(error: unknown): FailureType {
    return error instanceof AccountsUnavailableError ? 'config' : 'system';
  }

  override coverage(_stream: Stream): ExtractionCoverage {
    return localAppleStoreCoverage;
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
    scan: AccountsScan,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === undefined)
      throw new Error(`Apple Accounts has no stream ${stream.name}`);
    const records = reader.read(scan);
    yield* configuration.syncMode === 'incremental'
      ? diffSnapshot(stream, records, state)
      : records.map((data) => ({ stream: stream.name, data }));
  }
}
