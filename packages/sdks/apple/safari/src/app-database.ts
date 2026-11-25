import { FullDiskAccess } from '@zukhruf/tcc';

import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const safariStore = new Store('Safari data', {
  missing: '',
  service: new FullDiskAccess(),
});

export const appDatabase = new AppDatabase(safariStore);
