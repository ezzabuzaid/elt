import type { RecordDraft } from '@workspace/elt';
import type { TabHistoryEntry } from '@workspace/sdk-apple-safari';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';

const { nullableText } = safariFields;

const properties = {
  tabId: { ...safariFields.id, description: 'The tab; refers to tabs.id.' },
  position: {
    ...safariFields.ordinal,
    description: 'Index in the tab back and forward list, oldest first.',
  },
  current: {
    ...safariFields.boolean,
    description: 'Whether the tab shows this entry.',
  },
  url: { ...nullableText, description: 'Page URL; NULL when absent.' },
  originalUrl: {
    ...nullableText,
    description: 'URL first requested before redirects; NULL when absent.',
  },
  title: { ...nullableText, description: 'Page title; NULL when absent.' },
  scriptCreated: {
    ...safariFields.boolean,
    description:
      'Whether page script created the entry without user interaction.',
  },
  externalUrlPolicy: {
    ...nullableText,
    description:
      'Whether links from this entry may open other apps, as Safari stores it; NULL when absent.',
  },
} as const;

// One entry of one tab's back and forward list.
type Entry = {
  readonly tabId: string | null;
  readonly entry: TabHistoryEntry;
};

export class TabHistoryEntriesStream extends SafariStream<
  typeof properties,
  Entry
> {
  readonly name = 'tabHistoryEntries';
  readonly store = 'tabs';
  readonly primaryKey = ['tabId', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per page in a tab back and forward list (SafariTabs.db SessionState). Page form and scroll state are WebKit data and are not exported. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly Entry[] {
    return scan.tabs.tabs.flatMap((tab) =>
      tab.sessionHistory().map((entry) => ({ tabId: tab.id, entry })),
    );
  }

  protected record({ tabId, entry }: Entry): RecordDraft<typeof properties> {
    return {
      tabId,
      position: entry.position,
      current: entry.current,
      url: entry.url,
      originalUrl: entry.originalUrl,
      title: entry.title,
      scriptCreated: entry.scriptCreated,
      externalUrlPolicy: entry.externalUrlPolicy,
    };
  }
}
