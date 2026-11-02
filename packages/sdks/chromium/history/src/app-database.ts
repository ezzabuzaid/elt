import { AppDatabase } from '@workspace/sdk-macos-app-database';

import { ChromiumHistoryUnavailableError } from './errors.ts';

export const appDatabase = new AppDatabase({
  unavailable: ChromiumHistoryUnavailableError,
});
