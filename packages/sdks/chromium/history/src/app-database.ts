import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const appDatabase = new AppDatabase(
  new Store(
    'The history',
    'The file is missing, or this process has no access to it.',
  ),
);
