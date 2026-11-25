import { FullDiskAccess } from '@zukhruf/tcc';

import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const appDatabase = new AppDatabase(
  new Store('knowledgeC', {
    missing: '',
    service: new FullDiskAccess(),
  }),
);
