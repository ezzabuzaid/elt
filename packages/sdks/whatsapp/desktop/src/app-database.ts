import { AppDatabase, Store } from '@workspace/sdk-macos-app-database';

export const appDatabase = new AppDatabase(
  new Store(
    'The WhatsApp store',
    'Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security, and open WhatsApp once so it creates its stores.',
  ),
);
