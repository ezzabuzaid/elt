import type { RecordDraft } from '@workspace/elt';

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

const { nullableText, nullableTimestamp, nullableInteger } = safariFields;

const properties = {
  id: {
    ...safariFields.id,
    description: 'Reading List item UUID (WebBookmarkUUID).',
  },
  position: {
    ...safariFields.ordinal,
    description: 'Index in the Reading List, as Safari orders it.',
  },
  title: {
    ...nullableText,
    description: 'Displayed title; NULL when absent.',
  },
  url: { ...safariFields.text, description: 'The saved URL.' },
  addedAt: {
    ...nullableTimestamp,
    description: 'When the item was added to the Reading List.',
  },
  lastViewedAt: {
    ...nullableTimestamp,
    description: 'When the item was last opened; NULL while it is unread.',
  },
  previewText: {
    ...nullableText,
    description: 'Preview text Safari shows under the title; NULL when none.',
  },
  imageUrl: {
    ...nullableText,
    description: 'URL of the preview image; NULL when none.',
  },
  fetchedTitle: {
    ...nullableText,
    description:
      'Page title Safari fetched for offline reading; NULL when none.',
  },
  fetchedAt: {
    ...nullableTimestamp,
    description:
      'When Safari last fetched the page for offline reading; NULL when never.',
  },
  fetchResult: {
    ...nullableInteger,
    description:
      'Safari result code of the last offline fetch, as stored; NULL when never fetched.',
  },
  failedLoads: {
    ...nullableInteger,
    description:
      'Offline fetches that failed with an unknown or unrecoverable error; NULL when none were recorded.',
  },
  addedLocally: {
    ...safariFields.boolean,
    description:
      'Whether the item was added on this Mac rather than synced from another device.',
  },
  metadataFetchFailures: {
    ...nullableInteger,
    description:
      'Times Safari failed to fetch page details for the sidebar; NULL when none were recorded.',
  },
  featureText: {
    ...nullableText,
    description:
      'Summary text Safari fetched for the page; NULL when it fetched none.',
  },
} as const;

export class ReadingListItemsStream extends SafariStream<
  typeof properties,
  BookmarkNode
> {
  readonly name = 'readingListItems';
  readonly store = 'bookmarks';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per Safari Reading List item (Bookmarks.plist). Offline copies of the pages are not exported. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly BookmarkNode[] {
    return scan.bookmarks.readingList;
  }

  protected record({
    node,
    position,
  }: BookmarkNode): RecordDraft<typeof properties> {
    const saved = dictionary(node.ReadingList);
    const fetched = dictionary(node.ReadingListNonSync);
    return {
      id: node.WebBookmarkUUID,
      position,
      title: text(dictionary(node.URIDictionary).title),
      url: node.URLString,
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
  }
}
