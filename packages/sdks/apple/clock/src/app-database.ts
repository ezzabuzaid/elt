import { FullDiskAccess } from '@zukhruf/tcc';

import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const clockStore = new Store('The Clock store', {
  missing: 'Open Clock once.',
  service: new FullDiskAccess(),
});

export const appDatabase = new AppDatabase(clockStore);
