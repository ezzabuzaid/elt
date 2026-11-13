import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const mailStore = new Store("Mail's store", {
  missing: '',
  grant: 'full-disk-access',
});

export const appDatabase = new AppDatabase(mailStore);
