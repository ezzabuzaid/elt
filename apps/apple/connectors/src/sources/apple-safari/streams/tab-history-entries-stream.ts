import type { SchemaRecord } from 'elt';
import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import { flag, text } from '../safari-values.ts';
import type { HistoryEntry } from '../tabs-reader.ts';

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

export class TabHistoryEntriesStream extends SafariStream<
  typeof properties,
  HistoryEntry
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

  protected rows(scan: SafariScan): readonly HistoryEntry[] {
    return scan.tabs.historyEntries();
  }

  protected record({
    tab,
    entry,
    position,
    current,
  }: HistoryEntry): SchemaRecord<typeof properties> {
    return {
      tabId: tab.external_uuid as string,
      position,
      current,
      url: text(entry.SessionHistoryEntryURL),
      originalUrl: text(entry.SessionHistoryEntryOriginalURL),
      title: text(entry.SessionHistoryEntryTitle),
      scriptCreated: flag(
        entry.SessionHistoryEntryWasCreatedByJSWithoutUserInteraction,
      ),
      externalUrlPolicy: text(
        entry.SessionHistoryEntryShouldOpenExternalURLsPolicyKey,
      ),
    };
  }
}
