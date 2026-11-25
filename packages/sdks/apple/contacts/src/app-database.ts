import { Contacts } from '@zukhruf/tcc';

import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const contactsStore = new Store('The Contacts store', {
  missing: '',
  service: new Contacts(),
});

export const appDatabase = new AppDatabase(contactsStore);
