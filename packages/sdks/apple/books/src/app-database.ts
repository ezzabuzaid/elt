import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const booksStore = new Store(
  'Books data',
  'Open Books once so it creates its stores; if they exist, allow the process that runs the export Full Disk Access in System Settings > Privacy & Security. Books does not need to be open.',
);

export const appDatabase = new AppDatabase(booksStore);
