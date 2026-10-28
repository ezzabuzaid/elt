import { AppDatabase } from '@workspace/sdk-macos-app-database';

import { WhatsAppUnavailableError } from './errors.ts';

export const appDatabase = new AppDatabase({
  unavailable: WhatsAppUnavailableError,
});
