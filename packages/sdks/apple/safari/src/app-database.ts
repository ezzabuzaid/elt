import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const safariStore = new Store('Safari data', {
  missing: '',
  grant: 'full-disk-access',
});

export const appDatabase = new AppDatabase(safariStore);
