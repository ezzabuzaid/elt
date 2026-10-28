import { AppDatabase } from '@workspace/sdk-macos-app-database';

import { MailUnavailableError } from './errors.ts';

export const appDatabase = new AppDatabase({
  unavailable: MailUnavailableError,
});
