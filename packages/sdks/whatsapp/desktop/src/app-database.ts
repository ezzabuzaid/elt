import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const appDatabase = new AppDatabase(
  new Store('The WhatsApp store', {
    missing: 'Open WhatsApp once so it creates its stores.',
    grant: 'full-disk-access',
  }),
);
