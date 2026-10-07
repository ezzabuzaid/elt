import type { PlistValue } from '@workspace/codec-plist';

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

export const bookmarkKinds = ['folder', 'bookmark', 'proxy'] as const;
export type BookmarkKind = (typeof bookmarkKinds)[number];

// A proxy is a placeholder such as the History entry of the Bookmarks menu.
const kindsByType = new Map<unknown, BookmarkKind>([
  ['WebBookmarkTypeList', 'folder'],
  ['WebBookmarkTypeLeaf', 'bookmark'],
  ['WebBookmarkTypeProxy', 'proxy'],
]);

// Safari names the Reading List folder by this title.
const readingListTitle = 'com.apple.ReadingList';

export type Bookmark = {
  readonly id: string | null;
  // The containing folder's UUID; null at the top level.
  readonly parentId: string | null;
  readonly position: number;
  readonly kind: BookmarkKind | null;
  // Its own title, or else the title of the page it points to.
  readonly title: string | null;
  readonly url: string | null;
  readonly identifier: string | null;
  readonly hidden: boolean;
  readonly addedAt: Date | null;
  readonly description: string | null;
  readonly descriptionUserDefined: boolean;
  readonly featureText: string | null;
  readonly metadataFetchFailures: number | null;
  readonly serverId: string | null;
};

export type ReadingListItem = {
  readonly id: string | null;
  readonly position: number;
  readonly title: string | null;
  readonly url: string | null;
  readonly addedAt: Date | null;
  readonly lastViewedAt: Date | null;
  // The preview Safari saved with the item, or else the one it fetched.
  readonly previewText: string | null;
  readonly imageUrl: string | null;
  readonly fetchedTitle: string | null;
  readonly fetchedAt: Date | null;
  readonly fetchResult: number | null;
  readonly failedLoads: number | null;
  readonly addedLocally: boolean;
  readonly metadataFetchFailures: number | null;
  readonly featureText: string | null;
};

const bookmark = (
  node: Dictionary,
  parentId: string | null,
  position: number,
): Bookmark => ({
  id: stored(node.WebBookmarkUUID),
  parentId,
  position,
  kind: kindsByType.get(node.WebBookmarkType) ?? null,
  title: text(node.Title) ?? text(dictionary(node.URIDictionary).title),
  url: text(node.URLString),
  identifier: text(node.WebBookmarkIdentifier),
  hidden: flag(node.ShouldOmitFromUI),
  addedAt: plistTime(node.dateAdded),
  description: text(node.previewText),
  descriptionUserDefined: flag(node.previewTextIsUserDefined),
  featureText: text(node.featureText),
  metadataFetchFailures: integer(
    dictionary(node.ReadingListNonSync)
      .BookmarkSidebarMetadataFetchFailuresDueToUnknownOrNonRecoverableErrorKey,
  ),
  serverId: text(dictionary(node.Sync).ServerID),
});

const readingListItem = (
  node: Dictionary,
  position: number,
): ReadingListItem => {
  const saved = dictionary(node.ReadingList);
  const fetched = dictionary(node.ReadingListNonSync);
  return {
    id: stored(node.WebBookmarkUUID),
    position,
    title: text(dictionary(node.URIDictionary).title),
    url: stored(node.URLString),
    addedAt: plistTime(saved.DateAdded),
    lastViewedAt: plistTime(saved.DateLastViewed),
    previewText: text(saved.PreviewText) ?? text(node.previewText),
    imageUrl: text(node.imageURL),
    fetchedTitle: text(fetched.Title),
    fetchedAt: plistTime(fetched.DateLastFetched),
    fetchResult: integer(fetched.FetchResult),
    failedLoads: integer(
      fetched.NumberOfFailedLoadsWithUnknownOrNonRecoverableError,
    ),
    addedLocally: flag(fetched.AddedLocally),
    metadataFetchFailures: integer(
      fetched.BookmarkSidebarMetadataFetchFailuresDueToUnknownOrNonRecoverableErrorKey,
    ),
    featureText: text(node.featureText),
  };
};

// Bookmarks.plist in tree order: the Favorites bar, the Bookmarks menu and
// their folders, and the Reading List, whose items are read on their own.
export class Bookmarks {
  readonly bookmarks: Bookmark[] = [];
  readonly readingList: ReadingListItem[] = [];

  constructor(plist: PlistValue) {
    const root = dictionary(plist);
    if (typeof root.WebBookmarkType !== 'string')
      throw new TypeError('Bookmarks.plist has no root folder');
    const walk = (folder: Dictionary, parentId: string | null) =>
      list(folder.Children).forEach((child, position) => {
        const node = dictionary(child);
        if (
          folder.Title === readingListTitle &&
          node.WebBookmarkType === 'WebBookmarkTypeLeaf'
        ) {
          this.readingList.push(readingListItem(node, position));
          return;
        }
        this.bookmarks.push(bookmark(node, parentId, position));
        walk(node, String(node.WebBookmarkUUID));
      });
    walk(root, null);
  }
}
