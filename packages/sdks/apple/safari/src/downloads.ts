import { existsSync } from 'node:fs';

import type { PlistValue } from '@eltjs/codec-plist';

import {
  type Dictionary,
  dictionary,
  flag,
  integer,
  list,
  plistTime,
  stored,
  text,
} from './safari-values.ts';

// A download is identified by its place in the list, as the list repeats
// an identifier.
export type Download = {
  readonly position: number;
  readonly identifier: string | null;
  readonly profileId: string | null;
  readonly url: string | null;
  // Where the file was saved.
  readonly path: string | null;
  // Where it went after Safari opened it, such as an unpacked archive.
  readonly openedPath: string | null;
  readonly addedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly bytesReceived: number | null;
  readonly bytesTotal: number | null;
  readonly removeWhenDone: boolean;
  // Whether the saved file exists now.
  readonly availableLocally: boolean;
};

const download = (entry: Dictionary, position: number): Download => {
  const path = stored(entry.DownloadEntryPath);
  return {
    position,
    identifier: stored(entry.DownloadEntryIdentifier),
    profileId: text(entry.DownloadEntryProfileUUIDStringKey),
    url: stored(entry.DownloadEntryURL),
    path,
    openedPath: text(entry.DownloadEntryPostPath),
    addedAt: plistTime(entry.DownloadEntryDateAddedKey),
    finishedAt: plistTime(entry.DownloadEntryDateFinishedKey),
    bytesReceived: integer(entry.DownloadEntryProgressBytesSoFar),
    bytesTotal: integer(entry.DownloadEntryProgressTotalToLoad),
    removeWhenDone: flag(entry.DownloadEntryRemoveWhenDoneKey),
    get availableLocally() {
      return path !== null && path !== '' && existsSync(path);
    },
  };
};

// Downloads.plist: what Safari's Downloads list shows, until the user clears
// it or Safari removes finished items by its own setting.
export class Downloads {
  readonly downloads: Download[];

  constructor(plist: PlistValue) {
    const history = dictionary(plist).DownloadHistory;
    if (!Array.isArray(history))
      throw new TypeError('Downloads.plist lists no download history');
    this.downloads = list(history).map((entry, position) =>
      download(dictionary(entry), position),
    );
  }
}
