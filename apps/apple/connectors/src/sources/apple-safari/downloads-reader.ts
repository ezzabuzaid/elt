import type { PlistValue } from '../../platform/macos/plist.ts';
import { type ImportScope, selected } from '../import-scope.ts';
import { type Dictionary, dictionary, list } from './safari-values.ts';

// One run's read of Downloads.plist: what Safari's Downloads list shows, until
// the user clears it or Safari removes finished items by its own setting. The
// scope's profiles select entries.
export class DownloadsReader {
  readonly downloads: Dictionary[];

  constructor(plist: PlistValue, scope: ImportScope) {
    const history = dictionary(plist).DownloadHistory;
    if (!Array.isArray(history))
      throw new TypeError('Downloads.plist lists no download history');
    this.downloads = list(history)
      .map(dictionary)
      .filter((entry) =>
        selected(scope.collectionIds, entry.DownloadEntryProfileUUIDStringKey),
      );
  }
}
