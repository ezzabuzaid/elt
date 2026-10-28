import { AppDatabase } from '@workspace/sdk-macos-app-database';

import { NotificationCenterUnavailableError } from './errors.ts';

export const appDatabase = new AppDatabase({
  unavailable: NotificationCenterUnavailableError,
});
