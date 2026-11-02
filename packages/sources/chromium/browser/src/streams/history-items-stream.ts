import type { RecordDraft } from '@workspace/elt';
import type { HistoryUrl } from '@workspace/sdk-chromium-history';

import type { ChromiumScan, Profiled } from '../chromium-scan.ts';
import { ChromiumStream, chromiumFields } from '../chromium-stream.ts';

const properties = {
  profileId: chromiumFields.profileId,
  id: {
    ...chromiumFields.integer,
    description: 'The row id of the URL in the profile’s History.',
  },
  url: {
    ...chromiumFields.text,
    description: 'The address of the page.',
  },
  title: {
    ...chromiumFields.text,
    description: 'The title of the page at its last visit; empty when none.',
  },
  visitCount: {
    ...chromiumFields.integer,
    description: 'How many visits the browser counts for the URL.',
  },
  typedCount: {
    ...chromiumFields.integer,
    description: 'How many times the user typed the URL in the address bar.',
  },
  lastVisitedAt: {
    ...chromiumFields.instant,
    description:
      'When the URL was last visited; null when the browser recorded no time.',
  },
  hidden: {
    ...chromiumFields.boolean,
    description:
      'The browser hides the URL from its suggestions, as it does for a frame or a redirect.',
  },
} as const;

export class HistoryItemsStream extends ChromiumStream<
  typeof properties,
  Profiled<HistoryUrl>
> {
  readonly name = 'historyItems';
  readonly store = 'history';
  readonly description =
    'Each URL in the History of a profile, with its visit counts. historyVisits refer to it by profileId and urlId.';
  readonly properties = properties;
  readonly primaryKey = ['profileId', 'id'];

  // expires: whether the browser removes old history.
  constructor(expires: boolean) {
    super(expires ? ({ row }) => row.expiresAt : undefined);
  }

  protected rows(scan: ChromiumScan) {
    return scan.history.urls();
  }

  protected record({
    profileId,
    row,
  }: Profiled<HistoryUrl>): RecordDraft<typeof properties> {
    return {
      profileId,
      id: row.id,
      url: row.url,
      title: row.title,
      visitCount: row.visitCount,
      typedCount: row.typedCount,
      lastVisitedAt: row.lastVisitedAt,
      hidden: row.hidden,
    };
  }
}
