import type { RecordDraft } from '@workspace/elt';
import type { ReadingListItem } from '@workspace/sdk-apple-safari';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, iso, safariFields } from '../safari-stream.ts';

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
  ReadingListItem
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

  protected rows(scan: SafariScan): readonly ReadingListItem[] {
    return scan.bookmarks.readingList;
  }

  protected record(item: ReadingListItem): RecordDraft<typeof properties> {
    return {
      id: item.id,
      position: item.position,
      title: item.title,
      url: item.url,
      addedAt: iso(item.addedAt),
      lastViewedAt: iso(item.lastViewedAt),
      previewText: item.previewText,
      imageUrl: item.imageUrl,
      fetchedTitle: item.fetchedTitle,
      fetchedAt: iso(item.fetchedAt),
      fetchResult: item.fetchResult,
      failedLoads: item.failedLoads,
      addedLocally: item.addedLocally,
      metadataFetchFailures: item.metadataFetchFailures,
      featureText: item.featureText,
    };
  }
}
