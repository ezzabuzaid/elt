import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const appDatabase = new AppDatabase(
  new Store('knowledgeC', {
    missing: '',
    grant: 'full-disk-access',
  }),
);
