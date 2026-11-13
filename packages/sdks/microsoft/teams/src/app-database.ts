import { Store } from '@eltjs/sdk-macos-app-database';

export const teamsStore = new Store("The Microsoft Teams app's store", {
  missing: 'Open Teams, sign in and let it load your chats.',
  grant: 'full-disk-access',
});
