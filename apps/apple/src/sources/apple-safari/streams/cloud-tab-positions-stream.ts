import type { SchemaRecord } from 'elt';
import type { SortValue } from '../cloud-tabs-reader.ts';
import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import type { Row } from '../safari-values.ts';

const properties = {
  tabId: {
    ...safariFields.id,
    description: 'The tab; refers to cloudTabs.id.',
  },
  position: {
    ...safariFields.ordinal,
    description: 'Index of this entry in the tab position.',
  },
  changeId: {
    ...safariFields.integer,
    description: 'The change that wrote this sort value.',
  },
  sortValue: {
    ...safariFields.integer,
    description:
      'Ordering value iCloud Tabs uses to place the tab among its device tabs.',
  },
  deviceId: {
    ...safariFields.id,
    description:
      'Identifier of the device that wrote this sort value, as iCloud Tabs ordering records it; it is not a cloudTabDevices.id.',
  },
} as const;

type Entry = { tab: Row; entry: SortValue; index: number };

export class CloudTabPositionsStream extends SafariStream<
  typeof properties,
  Entry
> {
  readonly name = 'cloudTabPositions';
  readonly store = 'cloudTabs';
  readonly primaryKey = ['tabId', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per sort value in an iCloud tab position (CloudTabs.db cloud_tabs.position), which orders the tabs of a device. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly Entry[] {
    return scan.cloudTabs.positions();
  }

  protected record({
    tab,
    entry,
    index,
  }: Entry): SchemaRecord<typeof properties> {
    return {
      tabId: tab.tab_uuid as string,
      position: index,
      changeId: entry.changeID,
      sortValue: entry.sortValue,
      deviceId: entry.deviceIdentifier,
    };
  }
}
