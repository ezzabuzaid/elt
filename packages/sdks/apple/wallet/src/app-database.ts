import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const appDatabase = new AppDatabase(
  new Store('The Wallet store', { missing: '', denied: '' }),
);
