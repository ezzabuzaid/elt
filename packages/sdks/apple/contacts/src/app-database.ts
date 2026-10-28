import { AppDatabase } from '@workspace/sdk-macos-app-database';

import { ContactsUnavailableError } from './errors.ts';

export const appDatabase = new AppDatabase({
  unavailable: ContactsUnavailableError,
});
