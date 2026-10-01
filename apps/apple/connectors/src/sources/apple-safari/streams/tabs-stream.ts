import type { SchemaRecord } from 'elt';
import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import {
  appleTime,
  dictionary,
  flag,
  integer,
  list,
  number,
  plistTime,
  type Row,
  strings,
  text,
} from '../safari-values.ts';

const { boolean, nullableId, nullableText, nullableTimestamp } = safariFields;

const properties = {
  id: {
    ...safariFields.id,
    description:
      'Tab UUID; tabHistoryEntries.tabId and windowTabGroups.activeTabId refer to it.',
  },
  tabGroupId: {
    ...safariFields.id,
    description: 'The group holding the tab; refers to tabGroups.id.',
  },
  kind: {
    ...safariFields.text,
    enum: ['tab', 'favorite'],
    description:
      'tab: an open tab; favorite: an entry of a tab group own Favorites.',
  },
  profileId: {
    ...nullableId,
    description:
      'The profile the tab belongs to; refers to profiles.id. NULL when Safari records none.',
  },
  windowId: {
    ...nullableText,
    description:
      'The window the tab was last shown in; windows.id while that window is saved. NULL when not recorded.',
  },
  position: {
    ...safariFields.integer,
    description: 'Order within the tab group.',
  },
  tabIndex: {
    ...safariFields.nullableInteger,
    description: 'Position in the window tab bar; NULL when not recorded.',
  },
  title: { ...nullableText, description: 'Page title; NULL when absent.' },
  url: { ...nullableText, description: 'Page URL; NULL for an empty tab.' },
  localTitle: {
    ...nullableText,
    description:
      'Title this Mac shows, when it differs from the synced one; NULL when absent.',
  },
  localUrl: {
    ...nullableText,
    description:
      'URL this Mac shows, when it differs from the synced one; NULL when absent.',
  },
  pinned: { ...boolean, description: 'Whether the tab is pinned.' },
  pinnedTitle: {
    ...nullableText,
    description: 'Title the pinned tab keeps; NULL for unpinned tabs.',
  },
  pinnedUrl: {
    ...nullableText,
    description: 'Address the pinned tab returns to; NULL for unpinned tabs.',
  },
  addedAt: {
    ...nullableTimestamp,
    description: 'When the tab was opened; NULL when not recorded.',
  },
  lastViewedAt: {
    ...nullableTimestamp,
    description: 'When the tab was last shown; NULL when never.',
  },
  lastVisitedAt: {
    ...nullableTimestamp,
    description: 'When the tab last loaded a page; NULL when never.',
  },
  lastAccessedAt: {
    ...nullableTimestamp,
    description: 'When the tab was last accessed; NULL when never.',
  },
  modifiedAt: {
    ...nullableTimestamp,
    description: 'When Safari last changed the tab; NULL when not recorded.',
  },
  closedAt: {
    ...nullableTimestamp,
    description: 'When the tab was closed; NULL while open.',
  },
  muted: { ...boolean, description: 'Whether the tab is muted.' },
  showingReader: {
    ...boolean,
    description: 'Whether the tab shows the page in Reader.',
  },
  readerScrollOffset: {
    ...safariFields.nullableNumber,
    description: 'Reader scroll offset, in points; NULL when not recorded.',
  },
  openedFromLink: {
    ...boolean,
    description: 'Whether the tab was opened from a link.',
  },
  standaloneImage: {
    ...boolean,
    description: 'Whether the tab shows an image on its own.',
  },
  disposable: {
    ...boolean,
    description: 'Safari IsDisposable flag as stored.',
  },
  safeToLoad: { ...boolean, description: 'Safari SafeToLoad flag as stored.' },
  ancestorTabIds: {
    type: 'array',
    items: { type: 'string' },
    description:
      'UUIDs of the tabs this tab was opened from, in stored order; empty when opened directly.',
  },
  deviceId: {
    ...nullableText,
    description: 'Identifier of the device that opened the tab.',
  },
  topic: {
    ...nullableText,
    description: 'Topic Safari assigned to the page; NULL when none.',
  },
  pageLanguage: {
    ...nullableText,
    description: 'Language Safari detected for the page; NULL when none.',
  },
  pageSummary: {
    ...nullableText,
    description: 'Summary Safari derived for the page; NULL when none.',
  },
  pageKeywords: {
    type: 'array',
    items: { type: 'string' },
    description: 'Keywords Safari derived for the page; empty when none.',
  },
  pageKeywordWeights: {
    type: 'array',
    items: { type: 'number' },
    description: 'Weight of each pageKeywords entry, in the same order.',
  },
  featureText: {
    ...nullableText,
    description: 'Summary text Safari fetched for the page; NULL when none.',
  },
} as const;

export class TabsStream extends SafariStream<typeof properties, Row> {
  readonly name = 'tabs';
  readonly store = 'tabs';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per tab Safari keeps in its tab store (SafariTabs.db): open tabs of every window and tab group, pinned tabs, and tab group Favorites. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly Row[] {
    return scan.tabs.tabs;
  }

  protected record(
    row: Row,
    scan: SafariScan,
  ): SchemaRecord<typeof properties> {
    const { tabs } = scan;
    const [extra, local] = tabs.attributes(row);
    const context = dictionary(local.TabPageContextIDKey);
    const parent = tabs.row(row.parent);
    return {
      id: row.external_uuid as string,
      tabGroupId: tabs.uuid(row.parent) as string,
      kind:
        parent !== undefined && tabs.kind(parent) === 'favorites'
          ? 'favorite'
          : 'tab',
      profileId: tabs.profileOf(row),
      windowId: text(local.WindowUUID),
      position: row.order_index as number,
      tabIndex: integer(local.TabIndex),
      title: text(row.title),
      url: text(row.url),
      localTitle: text(extra.LocalTitle),
      localUrl: text(extra.LocalURL),
      pinned: flag(extra.IsPinned) || flag(local.IsPinned),
      pinnedTitle: text(extra.PinnedTitle) ?? text(local.PinnedPageTitle),
      pinnedUrl: text(extra.PinnedAddress) ?? text(local.PinnedPageURL),
      addedAt: plistTime(dictionary(extra['com.apple.Bookmark']).DateAdded),
      lastViewedAt: plistTime(extra.DateLastViewed),
      lastVisitedAt: plistTime(local.LastVisitTime),
      lastAccessedAt: plistTime(local.LastAccessDate),
      modifiedAt: appleTime(row.last_modified),
      closedAt: appleTime(row.date_closed) ?? plistTime(local.DateClosed),
      muted: flag(local.IsMuted),
      showingReader: flag(local.ShowingReader),
      readerScrollOffset: number(local.ReaderViewTopScrollOffset),
      openedFromLink: flag(local.OpenedFromLink),
      standaloneImage: flag(local.DisplayingStandaloneImage),
      disposable: flag(local.IsDisposable),
      safeToLoad: flag(local.SafeToLoad),
      ancestorTabIds: strings(local.AncestorTabUUIDsKey),
      deviceId: text(extra.DeviceIdentifier),
      topic: text(row.topic_title) ?? text(context.topicID),
      pageLanguage: text(context.pageLanguage),
      pageSummary: text(context.summary),
      pageKeywords: strings(context.keywords),
      pageKeywordWeights: list(context.keywordsWeights) as number[],
      featureText: text(extra.featureText),
    };
  }
}
