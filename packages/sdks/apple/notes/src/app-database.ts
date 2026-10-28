import { AppDatabase } from '@workspace/sdk-macos-app-database';

import { NotesUnavailableError } from './errors.ts';

export const appDatabase = new AppDatabase({
  unavailable: NotesUnavailableError,
});
