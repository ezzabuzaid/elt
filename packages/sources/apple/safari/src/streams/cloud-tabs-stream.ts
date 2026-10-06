import type { RecordDraft } from '@workspace/elt';
import type { CloudTab } from '@workspace/sdk-apple-safari';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, iso, safariFields } from '../safari-stream.ts';

const { boolean, nullableText } = safariFields;

const properties = {
  id: {
    ...safariFields.id,
    description:
      'iCloud Tabs tab identifier; cloudTabPositions.tabId and cloudTabCloseRequests.tabId refer to it.',
  },
  deviceId: {
    ...safariFields.id,
    description: 'The device the tab is open on; refers to cloudTabDevices.id.',
  },
  title: {
    ...nullableText,
    description: 'Page title; NULL when the page had none.',
  },
  url: { ...safariFields.text, description: 'The page URL.' },
  showingReader: {
    ...boolean,
    description: 'Whether the tab shows the page in Reader.',
  },
  pinned: { ...boolean, description: 'Whether the tab is pinned.' },
  readerScrollPageIndex: {
    ...safariFields.nullableInteger,
    description: 'Page index Reader was scrolled to; NULL when not recorded.',
  },
  sceneId: {
    ...nullableText,
    description:
      'The device window (scene) holding the tab; NULL when not recorded.',
  },
  lastViewedAt: {
    ...safariFields.nullableTimestamp,
    description:
      'When the tab was last viewed on its device; NULL when never recorded (stored as 0).',
  },
  topic: {
    ...nullableText,
    description: 'Topic Safari assigned to the page; NULL when none.',
  },
} as const;

export class CloudTabsStream extends SafariStream<typeof properties, CloudTab> {
  readonly name = 'cloudTabs';
  readonly store = 'cloudTabs';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per tab open on another device through iCloud Tabs (CloudTabs.db), as Safari on this Mac last fetched them. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly CloudTab[] {
    return scan.cloudTabs.tabs;
  }

  protected record(tab: CloudTab): RecordDraft<typeof properties> {
    return {
      id: tab.id,
      deviceId: tab.deviceId,
      title: tab.title,
      url: tab.url,
      showingReader: tab.showingReader,
      pinned: tab.pinned,
      readerScrollPageIndex: tab.readerScrollPageIndex,
      sceneId: tab.sceneId,
      lastViewedAt: iso(tab.lastViewedAt),
      topic: tab.topic,
    };
  }
}
