import type { SchemaRecord } from 'elt';
import type { BookmarkNode } from '../bookmarks-reader.ts';
import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import {
  dictionary,
  flag,
  integer,
  plistTime,
  text,
} from '../safari-values.ts';

const { nullableText } = safariFields;

const kinds = {
  WebBookmarkTypeList: 'folder',
  WebBookmarkTypeLeaf: 'bookmark',
  WebBookmarkTypeProxy: 'proxy',
} as const;

const properties = {
  id: {
    ...safariFields.id,
    description:
      'Bookmark UUID (WebBookmarkUUID); bookmarks.parentId refers to it.',
  },
  parentId: {
    ...safariFields.nullableId,
    description:
      'The containing folder; refers to bookmarks.id. NULL for the top-level folders.',
  },
  position: {
    ...safariFields.ordinal,
    description: 'Index within the containing folder, as Safari orders it.',
  },
  kind: {
    ...safariFields.text,
    enum: Object.values(kinds),
    description:
      'folder, bookmark, or proxy (a placeholder such as the History entry of the Bookmarks menu).',
  },
  title: {
    ...nullableText,
    description:
      'Displayed title. Safari names its top-level folders BookmarksBar (Favorites), BookmarksMenu and com.apple.ReadingList. NULL when absent.',
  },
  url: {
    ...nullableText,
    description: 'The bookmarked URL; NULL for folders and proxies.',
  },
  identifier: {
    ...nullableText,
    description:
      'Safari identifier of a built-in entry (WebBookmarkIdentifier), such as History; NULL otherwise.',
  },
  hidden: {
    ...safariFields.boolean,
    description: 'Whether Safari omits the entry from its bookmark lists.',
  },
  addedAt: {
    ...safariFields.nullableTimestamp,
    description:
      'When the bookmark was added; NULL when Safari did not record it.',
  },
  description: {
    ...nullableText,
    description:
      'Description shown under the bookmark: the one the user typed, or preview text Safari fetched; NULL when none.',
  },
  descriptionUserDefined: {
    ...safariFields.boolean,
    description: 'Whether the user typed the description.',
  },
  featureText: {
    ...nullableText,
    description:
      'Summary text Safari fetched for the page; NULL when it fetched none.',
  },
  metadataFetchFailures: {
    ...safariFields.nullableInteger,
    description:
      'Times Safari failed to fetch page details for the sidebar; NULL when none were recorded.',
  },
  serverId: {
    ...nullableText,
    description:
      'iCloud identifier of the entry; profiles.favoritesFolderServerId refers to a profile Favorites folder by it. NULL when never synced.',
  },
} as const;

export class BookmarksStream extends SafariStream<
  typeof properties,
  BookmarkNode
> {
  readonly name = 'bookmarks';
  readonly store = 'bookmarks';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per bookmark, folder and proxy in Safari bookmarks (Bookmarks.plist), including the Reading List folder but not its items, which readingListItems holds. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly BookmarkNode[] {
    return scan.bookmarks.bookmarks;
  }

  protected record({
    node,
    parentId,
    position,
  }: BookmarkNode): SchemaRecord<typeof properties> {
    return {
      id: node.WebBookmarkUUID as string,
      parentId,
      position,
      kind: kinds[node.WebBookmarkType as keyof typeof kinds],
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
    };
  }
}
