import type { RecordDraft } from '@workspace/elt';
import { type Bookmark, bookmarkKinds } from '@workspace/sdk-apple-safari';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, iso, safariFields } from '../safari-stream.ts';

const { nullableText } = safariFields;

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
    enum: bookmarkKinds,
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

export class BookmarksStream extends SafariStream<typeof properties, Bookmark> {
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

  protected rows(scan: SafariScan): readonly Bookmark[] {
    return scan.bookmarks.bookmarks;
  }

  protected record(bookmark: Bookmark): RecordDraft<typeof properties> {
    return {
      id: bookmark.id,
      parentId: bookmark.parentId,
      position: bookmark.position,
      kind: bookmark.kind,
      title: bookmark.title,
      url: bookmark.url,
      identifier: bookmark.identifier,
      hidden: bookmark.hidden,
      addedAt: iso(bookmark.addedAt),
      description: bookmark.description,
      descriptionUserDefined: bookmark.descriptionUserDefined,
      featureText: bookmark.featureText,
      metadataFetchFailures: bookmark.metadataFetchFailures,
      serverId: bookmark.serverId,
    };
  }
}
