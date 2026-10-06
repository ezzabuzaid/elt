import { homedir } from 'node:os';
import { join } from 'node:path';

import { defaultProfile } from './safari-tabs.ts';

// History, bookmarks, closed tabs and downloads.
export const safariDirectory = join(homedir(), 'Library/Safari');
// Open tabs, tab groups, profiles and iCloud Tabs.
export const safariContainer = join(
  homedir(),
  'Library/Containers/com.apple.Safari/Data/Library/Safari',
);

export type SafariLocation = {
  // ~/Library/Safari: History.db and the property lists.
  readonly directory: string;
  // Safari's container: SafariTabs.db, CloudTabs.db and each other profile's
  // History.db.
  readonly container: string;
};

// Where Safari keeps each kind of data: databases it commits to, and property
// lists it rewrites whole.
export type SafariStore =
  'history' | 'tabs' | 'cloudTabs' | 'bookmarks' | 'closedTabs' | 'downloads';

// The file each store keeps; history has one more History.db per profile.
export const storeFiles = ({ directory, container }: SafariLocation) =>
  ({
    history: join(directory, 'History.db'),
    tabs: join(container, 'SafariTabs.db'),
    cloudTabs: join(container, 'CloudTabs.db'),
    bookmarks: join(directory, 'Bookmarks.plist'),
    closedTabs: join(directory, 'RecentlyClosedTabs.plist'),
    downloads: join(directory, 'Downloads.plist'),
  }) satisfies Record<SafariStore, string>;

// The default profile keeps its history in ~/Library/Safari; every other
// profile in the container's Profiles folder named by its server_id.
export const profileHistory = (
  { directory, container }: SafariLocation,
  serverId: string,
) =>
  serverId === defaultProfile
    ? join(directory, 'History.db')
    : join(container, 'Profiles', serverId, 'History.db');
