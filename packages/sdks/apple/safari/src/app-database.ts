import { AppDatabase } from '@workspace/sdk-macos-app-database';

import { SafariUnavailableError } from './errors.ts';

export const appDatabase = new AppDatabase({
  unavailable: SafariUnavailableError,
});
