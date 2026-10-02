import type { ImportScope } from '@workspace/import-store';

import { AppleSafariSource } from '../sources/apple-safari/apple-safari-source.ts';
import { AppleApp } from './apple-app.ts';
import { type Choice, byId } from './choice.ts';

export class SafariApp extends AppleApp {
  readonly name = 'safari';
  readonly title = 'Safari';
  readonly datedBy = 'visit time';
  readonly fullDiskAccess = true;
  override readonly note =
    'Profiles select history, windows, tab groups, tabs, recently closed tabs and downloads. Dates select history visits, and the pages and topics those visits reach.';
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

  protected access(): string {
    return 'Open Safari to let it fetch history and tabs from your other devices.';
  }

  protected source(scope: ImportScope) {
    return new AppleSafariSource({ scope });
  }
}
