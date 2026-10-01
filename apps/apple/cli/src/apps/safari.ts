import { AppleSafariSource } from 'apple/sources/apple-safari/apple-safari-source';
import type { ImportScope } from 'import-store';
import { AppleApp } from './apple-app.ts';
import { byId, type Choice } from './choice.ts';

export class SafariApp extends AppleApp {
  readonly name = 'safari';
  readonly title = 'Safari';
  readonly datedBy = 'visit time';
  protected readonly choices: readonly Choice[] = [
    {
      stream: 'profiles',
      scope: 'collectionIds',
      title: 'profiles',
      id: byId,
      // Safari stores no name for the profile it starts with.
      label: (row) => String(row.title ?? 'Default profile'),
    },
  ];
  // Bookmarks, the Reading List and iCloud Tabs belong to no profile or date.
  protected readonly unscoped = [
    'bookmarks',
    'readingListItems',
    'cloudTabDevices',
    'cloudTabs',
    'cloudTabPositions',
    'cloudTabCloseRequests',
  ];
  protected readonly storeCopies = [];

  protected access(terminal: string): string {
    return this.fullDiskAccess(terminal);
  }

  protected source(scope: ImportScope) {
    return new AppleSafariSource({ scope });
  }
}
