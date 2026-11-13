import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const appDatabase = new AppDatabase(
  new Store('The Notification Center store', {
    missing:
      'The notification service of macOS (usernoted) makes it when it starts: log out and log in again.',
    denied:
      'Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security.',
  }),
);
