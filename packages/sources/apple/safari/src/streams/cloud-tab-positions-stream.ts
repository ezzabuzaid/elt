import type { RecordDraft } from '@workspace/elt';
import type { SortValue } from '@workspace/sdk-apple-safari';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';

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

// One entry of one iCloud tab's position.
type Entry = {
  readonly tabId: string | null;
  readonly position: number;
  readonly entry: SortValue;
};

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
    return scan.cloudTabs.tabs.flatMap((tab) =>
      tab
        .positions()
        .map((entry, position) => ({ tabId: tab.id, position, entry })),
    );
  }

  protected record({
    tabId,
    position,
    entry,
  }: Entry): RecordDraft<typeof properties> {
    return {
      tabId,
      position,
      changeId: entry.changeID,
      sortValue: entry.sortValue,
      deviceId: entry.deviceIdentifier,
    };
  }
}
