import { FullDiskAccess } from '@zukhruf/tcc';

import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const booksStore = new Store('Books data', {
  missing: 'Open Books once so it creates its stores.',
  service: new FullDiskAccess(),
});

export const appDatabase = new AppDatabase(booksStore);
