import type { RecordDraft } from '@workspace/elt';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import { type Row, appleTime, flag, text } from '../safari-values.ts';
import { windowState, windowStateFields } from '../window-state.ts';

const { nullableId, nullableText } = safariFields;

const properties = {
  id: {
    ...safariFields.id,
    description:
      'Window UUID; tabs.windowId, windowTabGroups.windowId and windowProfiles.windowId refer to it.',
  },
  profileId: {
    ...nullableId,
    description:
      'The profile the window shows; refers to profiles.id. NULL when not recorded.',
  },
  activeTabGroupId: {
    ...nullableId,
    description: 'The tab group the window shows; refers to tabGroups.id.',
  },
  localTabGroupId: {
    ...nullableId,
    description:
      'The window own unnamed tab group of ordinary tabs; refers to tabGroups.id.',
  },
  privateTabGroupId: {
    ...nullableId,
    description:
      'The window own group of private tabs; refers to tabGroups.id.',
  },
  lastSession: {
    ...safariFields.boolean,
    description: 'Whether the window belongs to the last saved session.',
  },
  sceneId: {
    ...nullableText,
    description: 'Scene identifier of the window; NULL when not recorded.',
  },
  ...windowStateFields,
} as const;

export class WindowsStream extends SafariStream<typeof properties, Row> {
  readonly name = 'windows';
  readonly store = 'tabs';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per Safari window in the saved session (SafariTabs.db windows), with its state as Safari last saved it. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly Row[] {
    return scan.tabs.windows;
  }

  protected record(row: Row, scan: SafariScan): RecordDraft<typeof properties> {
    const { tabs } = scan;
    const state = windowState(tabs.windowState(row));
    return {
      id: row.uuid,
      profileId: tabs.uuid(row.active_profile_id),
      activeTabGroupId: tabs.uuid(row.active_tab_group_id),
      localTabGroupId: tabs.uuid(row.local_tab_group_id),
      privateTabGroupId: tabs.uuid(row.private_tab_group_id),
      lastSession: flag(row.is_last_session),
      sceneId: text(row.scene_id),
      ...state,
      closedAt: appleTime(row.date_closed) ?? state.closedAt,
    };
  }
}
