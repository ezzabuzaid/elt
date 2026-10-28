import { AppDatabase } from '@workspace/sdk-macos-app-database';

import { WalletUnavailableError } from './errors.ts';

export const appDatabase = new AppDatabase({
  unavailable: WalletUnavailableError,
});
