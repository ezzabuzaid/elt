import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const contactsStore = new Store('The Contacts store', {
  missing: '',
  grant: 'contacts',
});

export const appDatabase = new AppDatabase(contactsStore);
