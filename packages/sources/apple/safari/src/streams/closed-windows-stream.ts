import type { RecordDraft } from '@workspace/elt';
import type { ClosedWindow } from '@workspace/sdk-apple-safari';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import { windowState, windowStateFields } from '../window-state.ts';

const properties = {
  id: {
    ...safariFields.id,
    description:
      'Closed window UUID; closedTabs.closedWindowId and closedWindowActiveTabs.windowId refer to it.',
  },
  position: {
    ...safariFields.ordinal,
    description: 'Index in the Recently Closed list, as Safari orders it.',
  },
  profileId: safariFields.profileId,
  activeTabGroupId: {
    ...safariFields.nullableText,
    description:
      'The tab group shown when the window closed; closedTabs.tabGroupId uses the same identifiers. NULL when not recorded.',
  },
  ...windowStateFields,
} as const;

export class ClosedWindowsStream extends SafariStream<
  typeof properties,
  ClosedWindow
> {
  readonly name = 'closedWindows';
  readonly store = 'closedTabs';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per window Safari lists under History > Recently Closed (RecentlyClosedTabs.plist). Its tabs are in closedTabs. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly ClosedWindow[] {
    return scan.closedTabs.windows;
  }

  protected record(window: ClosedWindow): RecordDraft<typeof properties> {
    return {
      id: window.id,
      position: window.position,
      profileId: window.profileId,
      activeTabGroupId: window.activeTabGroupId,
      ...windowState(window.state),
    };
  }
}
