import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const mailStore = new Store("Mail's store", {
  missing: '',
  denied:
    'Grant the exporting process Full Disk Access in System Settings > Privacy & Security.',
});

export const appDatabase = new AppDatabase(mailStore);
