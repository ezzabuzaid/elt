import type { RecordDraft } from '@workspace/elt';

import type { ClosedTab } from '../closed-tabs-reader.ts';
import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import { flag, integer, plistTime, strings, text } from '../safari-values.ts';

const { boolean, nullableText, nullableTimestamp } = safariFields;

const properties = {
  id: { ...safariFields.id, description: 'Closed tab UUID.' },
  closedWindowId: {
    ...safariFields.nullableId,
    description:
      'The recently closed window that held the tab; refers to closedWindows.id. NULL for a tab closed on its own.',
  },
  position: {
    ...safariFields.ordinal,
    description:
      'Index in the Recently Closed list for a tab closed on its own, or among its closed window tabs.',
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
  readonly primaryKey = ['id'];
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

  protected record({
    state,
    closedWindowId,
    position,
  }: ClosedTab): RecordDraft<typeof properties> {
    return {
      id: state.TabUUID,
      closedWindowId,
      position,
      windowId: text(state.WindowUUID),
      profileId: state.ProfileUUID,
      title: text(state.TabTitle),
      url: text(state.TabURL),
      closedAt: plistTime(state.DateClosed),
      lastVisitedAt: plistTime(state.LastVisitTime),
      tabIndex: integer(state.TabIndex),
      tabGroupId: text(state.TabGroupForTab),
      tabGroupType: flag(state.TabGroupTypeForTabKey),
      ancestorTabIds: strings(state.AncestorTabUUIDsKey),
      muted: flag(state.IsMuted),
      disposable: flag(state.IsDisposable),
      safeToLoad: flag(state.SafeToLoad),
    };
  }
}
