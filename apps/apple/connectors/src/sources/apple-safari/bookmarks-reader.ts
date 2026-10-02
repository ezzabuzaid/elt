import type { PlistValue } from '../../platform/macos/plist.ts';
import { type Dictionary, dictionary, list } from './safari-values.ts';

// A node of Bookmarks.plist in tree order, with its place in its folder.
export type BookmarkNode = {
  readonly node: Dictionary;
  readonly parentId: string | null;
  readonly position: number;
};

// Safari names the Reading List folder by this title.
const readingListTitle = 'com.apple.ReadingList';

// One run's read of Bookmarks.plist: the Favorites bar, the Bookmarks menu and
// their folders, and the Reading List, whose items read as their own stream.
export class BookmarksReader {
  readonly bookmarks: BookmarkNode[] = [];
  readonly readingList: BookmarkNode[] = [];

  constructor(plist: PlistValue) {
    const root = dictionary(plist);
    if (typeof root.WebBookmarkType !== 'string')
      throw new TypeError('Bookmarks.plist has no root folder');
    const walk = (folder: Dictionary, parentId: string | null) =>
      list(folder.Children).forEach((child, position) => {
        const node = dictionary(child);
        const entry = { node, parentId, position };
        if (
          folder.Title === readingListTitle &&
          node.WebBookmarkType === 'WebBookmarkTypeLeaf'
        ) {
          this.readingList.push(entry);
          return;
        }
        this.bookmarks.push(entry);
        walk(node, String(node.WebBookmarkUUID));
      });
    walk(root, null);
  }
}
