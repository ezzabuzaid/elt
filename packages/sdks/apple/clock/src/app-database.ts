import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const clockStore = new Store('The Clock store', {
  missing: 'Open Clock once.',
  denied:
    'Allow the process running the import Full Disk Access in System Settings > Privacy & Security.',
});

export const appDatabase = new AppDatabase(clockStore);
