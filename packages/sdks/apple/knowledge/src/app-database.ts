import { AppDatabase } from '@workspace/sdk-macos-app-database';

import { KnowledgeUnavailableError } from './errors.ts';

export const appDatabase = new AppDatabase({
  unavailable: KnowledgeUnavailableError,
});
