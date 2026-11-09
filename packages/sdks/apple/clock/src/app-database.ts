import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const clockStore = new Store(
  'The Clock store',
  'Open Clock once. If macOS denies access, allow the process running the import Full Disk Access in System Settings > Privacy & Security.',
);

export const appDatabase = new AppDatabase(clockStore);
