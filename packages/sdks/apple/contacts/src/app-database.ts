import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const contactsStore = new Store('The Contacts store', {
  missing: '',
  denied:
    'Allow the process that runs the export Contacts access or Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Contacts.app does not need to be open.',
});

export const appDatabase = new AppDatabase(contactsStore);
