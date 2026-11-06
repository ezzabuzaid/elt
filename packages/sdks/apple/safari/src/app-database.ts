import { AppDatabase, Store } from '@workspace/sdk-macos-app-database';

export const safariStore = new Store(
  'Safari data',
  'Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Safari does not need to be open.',
);

export const appDatabase = new AppDatabase(safariStore);
