import { FullDiskAccess } from '@zukhruf/tcc';

import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const appDatabase = new AppDatabase(
  new Store('The Notes store', {
    missing: '',
    service: new FullDiskAccess(),
  }),
);
