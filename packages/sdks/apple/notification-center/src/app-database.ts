import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const appDatabase = new AppDatabase(
  new Store(
    'The Notification Center store',
    'Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security.',
  ),
);
