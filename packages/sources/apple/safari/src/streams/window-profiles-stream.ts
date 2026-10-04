import type { RecordDraft } from '@workspace/elt';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import type { Row } from '../safari-values.ts';

const properties = {
  windowId: {
    ...safariFields.id,
    description: 'The window; refers to windows.id.',
  },
  profileId: {
    ...safariFields.id,
    description: 'A profile the window has shown; refers to profiles.id.',
  },
  activeTabGroupId: {
    ...safariFields.nullableId,
    description:
      'The tab group the window shows for that profile; refers to tabGroups.id.',
  },
} as const;

export class WindowProfilesStream extends SafariStream<typeof properties, Row> {
  readonly name = 'windowProfiles';
  readonly store = 'tabs';
  readonly primaryKey = ['windowId', 'profileId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per profile a window remembers, with the tab group it shows for it (SafariTabs.db windows_profiles). Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly Row[] {
    return scan.tabs.windowProfiles;
  }

  protected record(row: Row, scan: SafariScan): RecordDraft<typeof properties> {
    const { tabs } = scan;
    return {
      windowId: tabs.windowUuid(row.window_id),
      profileId: tabs.uuid(row.profile_id),
      activeTabGroupId: tabs.uuid(row.active_tab_group_id),
    };
  }
}
