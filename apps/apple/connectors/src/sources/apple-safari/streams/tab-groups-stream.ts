import type { RecordDraft } from '@workspace/elt';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import {
  type Row,
  appleTime,
  dictionary,
  flag,
  plistTime,
  text,
} from '../safari-values.ts';
import { tabGroupKinds } from '../tabs-reader.ts';

const { nullableId, nullableText } = safariFields;

const properties = {
  id: {
    ...safariFields.id,
    description:
      'Tab group UUID; tabs.tabGroupId and tabGroups.parentId refer to it.',
  },
  parentId: {
    ...nullableId,
    description:
      'The containing folder: another tabGroups.id, or a profiles.id. NULL for top-level groups and the default profile ones.',
  },
  profileId: {
    ...nullableId,
    description:
      'The profile the group belongs to; refers to profiles.id. NULL when Safari records none, as for the pinned-tab folders shared by all profiles.',
  },
  kind: {
    ...safariFields.text,
    enum: tabGroupKinds,
    description:
      'named: a tab group the user named; unnamed: a synced group of a window ordinary tabs; local and private: the window own groups of ordinary and private tabs; pinned and privatePinned: pinned tabs; recentlyClosed: tabs closed from tab groups; favorites: a group own Favorites; device: the folder of one device unnamed groups; special: another built-in folder.',
  },
  title: {
    ...nullableText,
    description: 'Name as Safari stores it; NULL when absent.',
  },
  position: {
    ...safariFields.integer,
    description: 'Order within the containing folder.',
  },
  hidden: {
    ...safariFields.boolean,
    description: 'Whether Safari hides the group from its lists.',
  },
  lastSelectedTabId: {
    ...nullableId,
    description:
      'The tab last shown in the group; refers to tabs.id. NULL when none.',
  },
  deviceType: {
    ...nullableText,
    description:
      'For a device folder, the Apple model identifier of the device; NULL otherwise.',
  },
  topic: {
    ...nullableText,
    description: 'Topic Safari assigned to the group; NULL when none.',
  },
  addedAt: {
    ...safariFields.nullableTimestamp,
    description: 'When the group was created; NULL when not recorded.',
  },
  modifiedAt: {
    ...safariFields.nullableTimestamp,
    description: 'When Safari last changed the group; NULL when not recorded.',
  },
  closedAt: {
    ...safariFields.nullableTimestamp,
    description: 'When the group was closed; NULL while open.',
  },
} as const;

export class TabGroupsStream extends SafariStream<typeof properties, Row> {
  readonly name = 'tabGroups';
  readonly store = 'tabs';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per Safari tab group and tab folder (SafariTabs.db bookmarks folders other than profiles): named and unnamed groups, each window own groups, pinned tabs, and group Favorites. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly Row[] {
    return scan.tabs.tabGroups;
  }

  protected record(row: Row, scan: SafariScan): RecordDraft<typeof properties> {
    const { tabs } = scan;
    const [extra] = tabs.attributes(row);
    return {
      id: row.external_uuid,
      parentId: row.parent === 0 ? null : tabs.uuid(row.parent),
      profileId: tabs.profileOf(row),
      kind: tabs.kind(row),
      title: text(row.title),
      position: row.order_index,
      hidden: flag(row.hidden),
      lastSelectedTabId: tabs.uuid(row.last_selected_child),
      deviceType: text(extra.DeviceTypeIdentifier),
      topic: text(row.topic_title),
      addedAt: plistTime(dictionary(extra['com.apple.Bookmark']).DateAdded),
      modifiedAt: appleTime(row.last_modified),
      closedAt: appleTime(row.date_closed),
    };
  }
}
