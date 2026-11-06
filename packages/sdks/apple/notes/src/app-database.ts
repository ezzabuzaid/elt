import { AppDatabase, Store } from '@workspace/sdk-macos-app-database';

export const appDatabase = new AppDatabase(
  new Store(
    'The Notes store',
    'Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Notes.app does not need to be open.',
  ),
);
