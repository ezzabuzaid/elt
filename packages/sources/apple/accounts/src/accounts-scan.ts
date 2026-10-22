import type { Account, AccountsSnapshot } from '@workspace/sdk-apple-accounts';

// One run's read of the Accounts store: every stream reads the same snapshot.
// Accounts are read once and kept for the run, since three streams project
// them and each links to its parent; every other kind of record is read from
// the snapshot as its stream iterates it, never held for the run.
export class AccountsScan implements AsyncDisposable {
  readonly snapshot: AccountsSnapshot;
  #accounts?: Account[];

  constructor(snapshot: AccountsSnapshot) {
    this.snapshot = snapshot;
  }

  get accounts(): readonly Account[] {
    this.#accounts ??= this.snapshot.accounts();
    return this.#accounts;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.snapshot[Symbol.dispose]();
  }
}
