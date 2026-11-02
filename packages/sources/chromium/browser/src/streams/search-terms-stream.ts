import type { RecordDraft } from '@workspace/elt';
import type { HistorySearchTerm } from '@workspace/sdk-chromium-history';

import type { ChromiumScan, Profiled } from '../chromium-scan.ts';
import { ChromiumStream, chromiumFields } from '../chromium-stream.ts';

const properties = {
  profileId: chromiumFields.profileId,
  keywordId: {
    ...chromiumFields.integer,
    description:
      'The search engine the user searched with, as the browser numbers it in its Web Data.',
  },
  urlId: {
    ...chromiumFields.integer,
    description:
      'The results page of the search; refers to historyItems.id of the same profile.',
  },
  term: {
    ...chromiumFields.text,
    description: 'What the user typed, as typed.',
  },
  normalizedTerm: {
    ...chromiumFields.text,
    description: 'The term in lower case with its spaces collapsed.',
  },
} as const;

export class SearchTermsStream extends ChromiumStream<
  typeof properties,
  Profiled<HistorySearchTerm>
> {
  readonly name = 'searchTerms';
  readonly store = 'history';
  readonly description =
    'Each search the user made from the address bar, with the results page it opened. A search goes with its results page.';
  readonly properties = properties;
  readonly primaryKey = ['profileId', 'keywordId', 'urlId'];

  // expires: whether the browser removes old history.
  constructor(expires: boolean) {
    super(expires ? ({ row }) => row.expiresAt : undefined);
  }

  protected rows(scan: ChromiumScan) {
    return scan.history.searchTerms();
  }

  protected record({
    profileId,
    row,
  }: Profiled<HistorySearchTerm>): RecordDraft<typeof properties> {
    return {
      profileId,
      keywordId: row.keywordId,
      urlId: row.urlId,
      term: row.term,
      normalizedTerm: row.normalizedTerm,
    };
  }
}
