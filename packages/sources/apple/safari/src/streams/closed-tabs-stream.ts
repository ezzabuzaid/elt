import type { RecordDraft } from '@eltjs/elt';
import type { ClosedTab } from '@eltjs/sdk-apple-safari';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, iso, safariFields } from '../safari-stream.ts';

const { boolean, nullableText, nullableTimestamp } = safariFields;

const properties = {
  entryPosition: {
    ...safariFields.ordinal,
    description:
      'Index in the Recently Closed list of the tab closed on its own, or of the closed window that held it; for a tab closed with its window, refers to closedWindows.position.',
  },
  position: {
    ...safariFields.ordinal,
    description:
      'Index among the tabs of its closed window; 0 for a tab closed on its own.',
  },
  tabId: {
    ...safariFields.id,
    description:
      'Closed tab UUID. Safari lists a tab again each time it closes it, so several records can hold one UUID.',
  },
  windowId: {
    ...nullableText,
    description: 'UUID of the window the tab was in; NULL when not recorded.',
  },
  profileId: safariFields.profileId,
  title: { ...nullableText, description: 'Tab title; NULL when absent.' },
  url: { ...nullableText, description: 'Tab URL; NULL when absent.' },
  closedAt: {
    ...nullableTimestamp,
    description: 'When the tab was closed.',
  },
  lastVisitedAt: {
    ...nullableTimestamp,
    description: 'When the tab last loaded a page; NULL when never.',
  },
  tabIndex: {
    ...safariFields.nullableInteger,
    description: 'Position of the tab in its tab bar; NULL when not recorded.',
  },
  tabGroupId: {
    ...nullableText,
    description: 'The tab group the tab belonged to; NULL when not recorded.',
  },
  tabGroupType: {
    ...boolean,
    description:
      'Safari TabGroupTypeForTabKey flag as stored; true in every entry observed, and Apple does not document it.',
  },
  ancestorTabIds: {
    type: 'array',
    items: { type: 'string' },
    description:
      'UUIDs of the tabs this tab was opened from, in stored order; empty when opened directly.',
  },
  muted: { ...boolean, description: 'Whether the tab was muted.' },
  disposable: {
    ...boolean,
    description: 'Safari IsDisposable flag as stored.',
  },
  safeToLoad: {
    ...boolean,
    description: 'Safari SafeToLoad flag as stored.',
  },
} as const;

export class ClosedTabsStream extends SafariStream<
  typeof properties,
  ClosedTab
> {
  readonly name = 'closedTabs';
  readonly store = 'closedTabs';
  readonly primaryKey = ['entryPosition', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per tab Safari lists under History > Recently Closed (RecentlyClosedTabs.plist), closed on its own or with its window. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly ClosedTab[] {
    return scan.closedTabs.tabs;
  }

  protected record(tab: ClosedTab): RecordDraft<typeof properties> {
    return {
      entryPosition: tab.entryPosition,
      position: tab.position,
      tabId: tab.tabId,
      windowId: tab.windowId,
      profileId: tab.profileId,
      title: tab.title,
      url: tab.url,
      closedAt: iso(tab.closedAt),
      lastVisitedAt: iso(tab.lastVisitedAt),
      tabIndex: tab.tabIndex,
      tabGroupId: tab.tabGroupId,
      tabGroupType: tab.tabGroupType,
      ancestorTabIds: tab.ancestorTabIds,
      muted: tab.muted,
      disposable: tab.disposable,
      safeToLoad: tab.safeToLoad,
    };
  }
}
