import { inflateSync } from 'node:zlib';

import type { SafariDatabase } from './safari-store.ts';
import type { Row } from './safari-values.ts';

// The CloudTabs.db columns this connector reads, checked against Safari 27 on
// macOS 27. system_fields holds each record's CloudKit metadata, not tab data.
export const cloudTabsColumns = {
  cloud_tab_devices: [
    'device_uuid',
    'device_name',
    'device_type_identifier',
    'has_duplicate_device_name',
    'is_ephemeral_device',
    'last_modified',
  ],
  cloud_tabs: [
    'tab_uuid',
    'device_uuid',
    'position',
    'title',
    'url',
    'is_showing_reader',
    'is_pinned',
    'reader_scroll_position_page_index',
    'scene_id',
    'last_viewed_time',
    'topic_title',
  ],
  cloud_tab_close_requests: [
    'close_request_uuid',
    'destination_device_uuid',
    'url',
    'tab_uuid',
  ],
} as const;

const select = (table: keyof typeof cloudTabsColumns, order: string) =>
  `SELECT ${cloudTabsColumns[table].join(', ')} FROM ${table} ORDER BY ${order}`;

// One entry of a tab's position: a sort value written by one change.
export type SortValue = {
  readonly changeID: number;
  readonly sortValue: number;
  readonly deviceIdentifier: string;
};

// One run's read of CloudTabs.db: the tabs open on the account's other devices,
// as Safari last fetched them from iCloud.
export class CloudTabsReader {
  readonly database: SafariDatabase;
  #tabs?: Row[];

  constructor(database: SafariDatabase) {
    this.database = database;
  }

  get devices(): Row[] {
    return this.database.all(select('cloud_tab_devices', 'device_uuid'));
  }

  get tabs(): Row[] {
    this.#tabs ??= this.database.all(select('cloud_tabs', 'tab_uuid'));
    return this.#tabs;
  }

  get closeRequests(): Row[] {
    return this.database.all(
      select('cloud_tab_close_requests', 'close_request_uuid'),
    );
  }

  // A tab's position is zlib-compressed JSON: {"sortValues": [...]}.
  positions(): { tab: Row; entry: SortValue; index: number }[] {
    return this.tabs.flatMap((tab) => {
      if (!(tab.position instanceof Uint8Array))
        throw new TypeError('A Safari iCloud tab has no position');
      const { sortValues }: { sortValues: SortValue[] } = JSON.parse(
        inflateSync(tab.position).toString('utf8'),
      );
      return sortValues.map((entry, index) => ({ tab, entry, index }));
    });
  }
}
