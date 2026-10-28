import { AppDatabase } from '@workspace/sdk-macos-app-database';

import { BooksUnavailableError } from './errors.ts';

export const appDatabase = new AppDatabase({
  unavailable: BooksUnavailableError,
});
