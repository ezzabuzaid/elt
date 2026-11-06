import { AppDatabase, Store } from '@workspace/sdk-macos-app-database';

export const mailStore = new Store(
  "Mail's store",
  'Grant the exporting process Full Disk Access in System Settings > Privacy & Security.',
);

export const appDatabase = new AppDatabase(mailStore);
