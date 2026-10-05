import { homedir } from 'node:os';
import { join } from 'node:path';

import { AppDatabaseVersion } from '@workspace/sdk-apple-app-database';

import { AccountsSnapshot } from './accounts-snapshot.ts';
import { AccountsUnavailableError } from './errors.ts';

// Where macOS keeps this user's Accounts store.
export const accountsStorePath = join(
  homedir(),
  'Library/Accounts/Accounts4.sqlite',
);

// The Accounts framework's Core Data store (Accounts4.sqlite), read without
// the framework: the store, not an app's scripting, holds every account.
export class AccountsStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  // The store as of one moment. accountsd commits about once a minute, so
  // what a run reads comes from one snapshot.
  open(): AccountsSnapshot {
    return new AccountsSnapshot(this.#path);
  }

  // A probe whose current value changes with each commit to the store, such
  // as accountsd saving an account.
  version(): AppDatabaseVersion {
    return new AppDatabaseVersion(this.#path, AccountsUnavailableError);
  }
}
