import type { SchemaRecord } from 'elt';
import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import { appleTime, flag, integer, type Row, text } from '../safari-values.ts';

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

export class CloudTabsStream extends SafariStream<typeof properties, Row> {
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

  protected rows(scan: SafariScan): readonly Row[] {
    return scan.cloudTabs.tabs;
  }

  protected record(row: Row): SchemaRecord<typeof properties> {
    return {
      id: row.tab_uuid as string,
      deviceId: row.device_uuid as string,
      title: text(row.title),
      url: row.url as string,
      showingReader: flag(row.is_showing_reader),
      pinned: flag(row.is_pinned),
      readerScrollPageIndex: integer(row.reader_scroll_position_page_index),
      sceneId: text(row.scene_id),
      lastViewedAt:
        row.last_viewed_time === 0 ? null : appleTime(row.last_viewed_time),
      topic: text(row.topic_title),
    };
  }
}
