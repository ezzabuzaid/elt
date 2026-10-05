import { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import type { Choice } from '@workspace/connector-apple-connector/choice';
import { AppleAccountsSource } from '@workspace/source-apple-accounts/apple-accounts-source';

export default class AccountsConnector extends AppleConnector {
  readonly datedBy = null;
  readonly fullDiskAccess = true;
  // One small store of every account on this Mac; everything is imported.
  protected readonly choices: readonly Choice[] = [];
  // Reading the accounts opens the protected Accounts store.
  protected override readonly probe = 'accounts';
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(): string {
    return 'No app needs to be open: macOS keeps every account its apps sync through in one store.';
  }

  protected source() {
    return new AppleAccountsSource();
  }
}
