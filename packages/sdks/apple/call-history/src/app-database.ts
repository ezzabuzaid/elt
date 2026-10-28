import { AppDatabase } from '@workspace/sdk-macos-app-database';

import { CallHistoryUnavailableError } from './errors.ts';

export const appDatabase = new AppDatabase({
  unavailable: CallHistoryUnavailableError,
});
