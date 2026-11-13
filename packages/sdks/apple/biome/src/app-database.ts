import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const biomeStore = new Store("Biome's store", {
  missing: '',
  denied:
    'Allow the process that reads it Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it.',
});

export const appDatabase = new AppDatabase(biomeStore);
