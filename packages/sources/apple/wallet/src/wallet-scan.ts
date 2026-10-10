import type { Pass } from '@workspace/sdk-apple-wallet';

// One run's read of Wallet: every pass, read once for every stream. The
// store's database closed once the passes were read, so nothing stays open.
export class WalletScan implements AsyncDisposable {
  readonly passes: readonly Pass[];

  constructor(passes: readonly Pass[]) {
    this.passes = passes;
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}
