import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  type PlistValue,
  isBinaryPlist,
  isDictionary,
  parseBinaryPlist,
  readPlist,
} from '@workspace/sdk-apple-plist';

import { Bookmarks } from './bookmarks.ts';
import { CloudTabs } from './cloud-tabs.ts';
import { Downloads } from './downloads.ts';
import { SafariUnavailableError } from './errors.ts';
import { RecentlyClosed } from './recently-closed.ts';
import { ProfileHistory } from './safari-history.ts';
import {
  type SafariLocation,
  type SafariStore,
  profileHistory,
  storeFiles,
} from './safari-location.ts';
import { SafariTabs, profileListings, tabsDatabase } from './safari-tabs.ts';
import { SafariVersion } from './safari-version.ts';

// Safari's own preferences, beside its container's Safari folder.
const preferences = ({ container }: SafariLocation) =>
  join(dirname(container), 'Preferences/com.apple.Safari.plist');

// One of Safari's property lists, whole: bookmarks, recently closed tabs or
// downloads. Safari writes them binary; plutil converts any other kind. A
// missing or unreadable file fails the read; it never reads as an empty list,
// which would delete every exported row.
async function readSafariPlist(path: string): Promise<PlistValue> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    throw new SafariUnavailableError(path, cause);
  }
  return isBinaryPlist(bytes) ? parseBinaryPlist(bytes) : readPlist(path);
}

// Safari's preferences, or null before Safari has written any: every setting
// then holds its default.
async function readSafariPreferences(path: string): Promise<PlistValue | null> {
  try {
    return await readSafariPlist(path);
  } catch (error) {
    if (
      error instanceof SafariUnavailableError &&
      error.cause instanceof Error &&
      'code' in error.cause &&
      error.cause.code === 'ENOENT'
    )
      return null;
    throw error;
  }
}

// "Remove history items" in Safari's General settings, as HistoryAgeInDaysLimit:
// its menu stores 1, 7, 14, 30 or 365 days, and Manually 365000. Safari's own
// defaults hold 365 while the key is unset, and it reads any value below 1 as
// one day (+[History ageLimitInterval]).
const defaultHistoryAgeInDays = 365;

// Every profile's History.db, each pinned to its own moment.
export class SafariHistory implements Disposable {
  readonly profiles: readonly ProfileHistory[];

  constructor(profiles: readonly ProfileHistory[]) {
    this.profiles = profiles;
  }

  [Symbol.dispose](): void {
    for (const profile of this.profiles) profile[Symbol.dispose]();
  }
}

// Safari's own stores, read without Safari, which need not run.
export class Safari {
  readonly location: SafariLocation;

  constructor(location: SafariLocation) {
    this.location = location;
  }

  // Each profile's History.db, as SafariTabs.db lists the profiles.
  history(): SafariHistory {
    const listings = (() => {
      using database = tabsDatabase(storeFiles(this.location).tabs);
      return profileListings(database);
    })();
    const profiles: ProfileHistory[] = [];
    try {
      for (const { profileId, serverId } of listings) {
        if (serverId === null || profileId === null)
          throw new TypeError('A Safari profile has no identifier');
        profiles.push(
          new ProfileHistory(
            profileHistory(this.location, serverId),
            profileId,
          ),
        );
      }
    } catch (error) {
      for (const profile of profiles) profile[Symbol.dispose]();
      throw error;
    }
    return new SafariHistory(profiles);
  }

  // How many days of history Safari keeps, from its preferences.
  async historyAgeInDays(): Promise<number> {
    const read = await readSafariPreferences(preferences(this.location));
    const configured = isDictionary(read)
      ? read.HistoryAgeInDaysLimit
      : undefined;
    const limit = configured ?? defaultHistoryAgeInDays;
    if (typeof limit !== 'number')
      throw new TypeError('Safari HistoryAgeInDaysLimit is not a number');
    return Math.max(1, limit);
  }

  tabs(): SafariTabs {
    return new SafariTabs(storeFiles(this.location).tabs);
  }

  cloudTabs(): CloudTabs {
    return new CloudTabs(storeFiles(this.location).cloudTabs);
  }

  async bookmarks(): Promise<Bookmarks> {
    return new Bookmarks(
      await readSafariPlist(storeFiles(this.location).bookmarks),
    );
  }

  async recentlyClosed(): Promise<RecentlyClosed> {
    return new RecentlyClosed(
      await readSafariPlist(storeFiles(this.location).closedTabs),
    );
  }

  async downloads(): Promise<Downloads> {
    return new Downloads(
      await readSafariPlist(storeFiles(this.location).downloads),
    );
  }

  // A probe whose current value changes when the store does.
  version(store: SafariStore): SafariVersion {
    return new SafariVersion(this.location, store);
  }
}
