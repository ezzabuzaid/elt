import { FullDiskAccess } from '@zukhruf/tcc';

import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const mailStore = new Store("Mail's store", {
  missing: '',
  service: new FullDiskAccess(),
});

export const appDatabase = new AppDatabase(mailStore);
