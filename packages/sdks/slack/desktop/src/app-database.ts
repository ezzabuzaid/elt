import { Store } from '@eltjs/sdk-macos-app-database';

export const slackStore = new Store("The Slack app's store", {
  missing: 'Open Slack, sign in and let it save its workspaces.',
  grant: 'full-disk-access',
});
