import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const clockStore = new Store('The Clock store', {
  missing: 'Open Clock once.',
  grant: 'full-disk-access',
});

export const appDatabase = new AppDatabase(clockStore);
