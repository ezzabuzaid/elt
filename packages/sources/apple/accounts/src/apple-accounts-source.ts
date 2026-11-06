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
  AccountsStore,
  StoreUnavailableError,
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
  readonly identity = 'apple-accounts';
  protected readonly catalog = catalog;
  readonly accounts = catalog.get(readers.accounts.name);
  readonly accountProperties = catalog.get(readers.accountProperties.name);
  readonly accountDataclasses = catalog.get(readers.accountDataclasses.name);
  readonly accountTypes = catalog.get(readers.accountTypes.name);
  readonly dataclasses = catalog.get(readers.dataclasses.name);
  readonly accessOptionKeys = catalog.get(readers.accessOptionKeys.name);
  readonly authorizations = catalog.get(readers.authorizations.name);
  readonly credentialItems = catalog.get(readers.credentialItems.name);

  readonly path: string;
  readonly #store: AccountsStore;

  constructor({ path }: { path: string }) {
    super();
    this.path = path;
    this.#store = new AccountsStore(path);
    Object.freeze(this);
  }

  protected override async open(): Promise<AccountsScan> {
    return new AccountsScan(this.#store.open());
  }

  protected override readonly configErrors = [StoreUnavailableError];

  override coverage(_stream: Stream): ExtractionCoverage {
    return localAppleStoreCoverage;
  }

  override async currentAsOf() {
    return null;
  }

  protected override async *observe({
    streams,
    signal,
    clock,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using version = this.#store.version();
    for await (const changed of pollChanges(
      new Map([['version', async () => version.current]]),
      { interval: pollIntervalMs, signal, clock },
    ))
      yield changed.size > 0 ? streams : [];
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: AccountsScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === undefined)
      throw new Error(`Apple Accounts has no stream ${stream.name}`);
    const records = reader.read(scan);
    yield* diffSnapshot(configuration, records, state, {
      policy: new ClosedWorld(),
      signal,
    });
  }
}
