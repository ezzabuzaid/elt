import { AppDatabase } from '@workspace/sdk-macos-app-database';

import { BiomeUnavailableError } from './errors.ts';

export const appDatabase = new AppDatabase({
  unavailable: BiomeUnavailableError,
});
