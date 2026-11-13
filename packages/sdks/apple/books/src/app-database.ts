import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const booksStore = new Store('Books data', {
  missing: 'Open Books once so it creates its stores.',
  grant: 'full-disk-access',
});

export const appDatabase = new AppDatabase(booksStore);
