import type {
  AccessOptionKey,
  Account,
  AccountType,
  AccountsSnapshot,
  Authorization,
  CredentialItem,
  Dataclass,
} from '@workspace/macos-accounts';

// One run's read of the Accounts store: every stream reads the same snapshot,
// and each kind of record is read from it once.
export class AccountsScan implements AsyncDisposable {
  readonly #snapshot: AccountsSnapshot;
  #accounts?: Account[];
  #accountTypes?: AccountType[];
  #dataclasses?: Dataclass[];
  #accessOptionKeys?: AccessOptionKey[];
  #authorizations?: Authorization[];
  #credentialItems?: CredentialItem[];

  constructor(snapshot: AccountsSnapshot) {
    this.#snapshot = snapshot;
  }

  get accounts(): readonly Account[] {
    this.#accounts ??= this.#snapshot.accounts();
    return this.#accounts;
  }

  get accountTypes(): readonly AccountType[] {
    this.#accountTypes ??= this.#snapshot.accountTypes();
    return this.#accountTypes;
  }

  get dataclasses(): readonly Dataclass[] {
    this.#dataclasses ??= this.#snapshot.dataclasses();
    return this.#dataclasses;
  }

  get accessOptionKeys(): readonly AccessOptionKey[] {
    this.#accessOptionKeys ??= this.#snapshot.accessOptionKeys();
    return this.#accessOptionKeys;
  }

  get authorizations(): readonly Authorization[] {
    this.#authorizations ??= this.#snapshot.authorizations();
    return this.#authorizations;
  }

  get credentialItems(): readonly CredentialItem[] {
    this.#credentialItems ??= this.#snapshot.credentialItems();
    return this.#credentialItems;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#snapshot[Symbol.dispose]();
  }
}
