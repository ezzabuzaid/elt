import { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import type { Choice } from '@workspace/connector-apple-connector/choice';
import { AppleWalletSource } from '@workspace/source-apple-wallet/apple-wallet-source';

export default class WalletConnector extends AppleConnector {
  // Wallet has no accounts or collections, and a pass's dates say when it is
  // relevant or expires, not which passes an import should keep.
  readonly datedBy = null;
  // passd's store is not behind Full Disk Access.
  readonly fullDiskAccess = false;
  protected readonly choices: readonly Choice[] = [];
  protected override readonly probe = 'passes';
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(): string {
    return 'No app needs to be open: macOS keeps the passes in Wallet on this Mac, with those iCloud brings from your iPhone.';
  }

  protected source() {
    return new AppleWalletSource();
  }
}
