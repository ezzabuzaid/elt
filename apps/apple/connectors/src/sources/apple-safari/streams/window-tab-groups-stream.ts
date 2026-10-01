import type { SchemaRecord } from 'elt';
import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import { flag, type Row } from '../safari-values.ts';

const properties = {
  windowId: {
    ...safariFields.id,
    description: 'The window; refers to windows.id.',
  },
  tabGroupId: {
    ...safariFields.id,
    description: 'A tab group of the window; refers to tabGroups.id.',
  },
  activeTabId: {
    ...safariFields.nullableId,
    description:
      'The tab the window shows in that group; refers to tabs.id. NULL when not recorded.',
  },
  unnamed: {
    ...safariFields.boolean,
    description: 'Whether the group is one of the window unnamed tab groups.',
  },
} as const;

export class WindowTabGroupsStream extends SafariStream<
  typeof properties,
  Row
> {
  readonly name = 'windowTabGroups';
  readonly store = 'tabs';
  readonly primaryKey = ['windowId', 'tabGroupId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per tab group a window holds or has shown, with its active tab (SafariTabs.db windows_tab_groups and windows_unnamed_tab_groups). Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly Row[] {
    return scan.tabs.windowTabGroups;
  }

  protected record(
    row: Row,
    scan: SafariScan,
  ): SchemaRecord<typeof properties> {
    const { tabs } = scan;
    return {
      windowId: tabs.windowUuid(row.window_id) as string,
      tabGroupId: tabs.uuid(row.tab_group_id) as string,
      activeTabId: tabs.uuid(row.active_tab_id),
      unnamed: flag(row.unnamed),
    };
  }
}
