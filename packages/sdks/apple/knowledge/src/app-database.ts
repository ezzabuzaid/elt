import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const appDatabase = new AppDatabase(
  new Store(
    'knowledgeC',
    'Allow the process that reads it Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it.',
  ),
);
