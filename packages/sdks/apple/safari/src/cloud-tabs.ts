import { inflateSync } from 'node:zlib';

import { AppDatabase } from '@workspace/sdk-apple-app-database';

import { SafariSchemaError, SafariUnavailableError } from './errors.ts';
import { appleTime, flag, integer, stored, text } from './safari-values.ts';

// The CloudTabs.db columns this reader reads, checked against Safari 27 on
// macOS 27. system_fields holds each record's CloudKit metadata, not tab data.
const cloudTabsColumns = {
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

export type CloudTabDevice = {
  readonly id: string | null;
  readonly name: string | null;
  readonly type: string | null;
  readonly duplicateName: boolean;
  readonly ephemeral: boolean;
  readonly modifiedAt: Date | null;
};

export type CloudTab = {
  readonly id: string | null;
  readonly deviceId: string | null;
  readonly title: string | null;
  readonly url: string | null;
  readonly showingReader: boolean;
  readonly pinned: boolean;
  readonly readerScrollPageIndex: number | null;
  readonly sceneId: string | null;
  // 0 means the tab was never viewed.
  readonly lastViewedAt: Date | null;
  readonly topic: string | null;
  // Its position: zlib-compressed JSON {"sortValues": [...]}.
  positions(): SortValue[];
};

export type CloudTabCloseRequest = {
  readonly id: string | null;
  readonly deviceId: string | null;
  readonly url: string | null;
  readonly tabId: string | null;
};

// CloudTabs.db: the tabs open on the account's other devices, as Safari last
// fetched them from iCloud.
export class CloudTabs implements Disposable {
  readonly #database: AppDatabase;

  constructor(path: string) {
    this.#database = new AppDatabase(path, SafariUnavailableError);
    this.#database.requireColumns(cloudTabsColumns, SafariSchemaError);
  }

  devices(): CloudTabDevice[] {
    return this.#database
      .all(select('cloud_tab_devices', 'device_uuid'))
      .map((row) => ({
        id: stored(row.device_uuid),
        name: text(row.device_name),
        type: text(row.device_type_identifier),
        duplicateName: flag(row.has_duplicate_device_name),
        ephemeral: flag(row.is_ephemeral_device),
        modifiedAt: appleTime(row.last_modified),
      }));
  }

  tabs(): CloudTab[] {
    return this.#database.all(select('cloud_tabs', 'tab_uuid')).map((row) => ({
      id: stored(row.tab_uuid),
      deviceId: stored(row.device_uuid),
      title: text(row.title),
      url: stored(row.url),
      showingReader: flag(row.is_showing_reader),
      pinned: flag(row.is_pinned),
      readerScrollPageIndex: integer(row.reader_scroll_position_page_index),
      sceneId: text(row.scene_id),
      lastViewedAt:
        row.last_viewed_time === 0 ? null : appleTime(row.last_viewed_time),
      topic: text(row.topic_title),
      positions: () => {
        if (!(row.position instanceof Uint8Array))
          throw new TypeError('A Safari iCloud tab has no position');
        const { sortValues }: { sortValues: SortValue[] } = JSON.parse(
          inflateSync(row.position).toString('utf8'),
        );
        return sortValues;
      },
    }));
  }

  closeRequests(): CloudTabCloseRequest[] {
    return this.#database
      .all(select('cloud_tab_close_requests', 'close_request_uuid'))
      .map((row) => ({
        id: stored(row.close_request_uuid),
        deviceId: stored(row.destination_device_uuid),
        url: stored(row.url),
        tabId: stored(row.tab_uuid),
      }));
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}
