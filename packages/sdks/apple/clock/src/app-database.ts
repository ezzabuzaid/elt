import { AppDatabase } from '@workspace/sdk-macos-app-database';

import { ClockUnavailableError } from './errors.ts';

export const appDatabase = new AppDatabase({
  unavailable: ClockUnavailableError,
});
