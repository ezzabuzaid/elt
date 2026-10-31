import { join } from 'node:path';

import type { AppDatabaseVersion } from '@workspace/sdk-macos-app-database';

import { appDatabase } from './app-database.ts';
import { NotificationCenterSnapshot } from './notification-center-snapshot.ts';

// Where macOS keeps Notification Center in the home folder `home`.
export const notificationCenterStorePath = (home: string): string =>
  join(home, 'Library/Group Containers/group.com.apple.usernoted/db2/db');

// The store usernoted keeps for Notification Center: the notifications it
// holds now, the apps that post them, and the categories those apps register.
// usernoted deletes a notification when its app withdraws it, the user clears
// it, a newer one replaces it or it expires, and records none of these.
export class NotificationCenterStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  // The store as of one moment, so a notification and its app agree.
  open(): NotificationCenterSnapshot {
    return new NotificationCenterSnapshot(this.#path);
  }

  // A probe whose current value changes with each commit to the store, such
  // as usernoted delivering, withdrawing or badging.
  version(): AppDatabaseVersion {
    return appDatabase.version(this.#path);
  }
}
