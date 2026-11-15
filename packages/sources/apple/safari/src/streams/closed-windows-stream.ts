import type { RecordDraft } from '@eltjs/elt';
import type { ClosedWindow } from '@eltjs/sdk-apple-safari';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import { windowState, windowStateFields } from '../window-state.ts';

const properties = {
  position: {
    ...safariFields.ordinal,
    description:
      'Index in the Recently Closed list, as Safari orders it; closedTabs.entryPosition and closedWindowActiveTabs.windowPosition refer to it.',
  },
  windowId: {
    ...safariFields.id,
    description:
      'Closed window UUID. Safari lists a window again each time it closes it, so several records can hold one UUID.',
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
  readonly primaryKey = ['position'];
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
      position: window.position,
      windowId: window.windowId,
      profileId: window.profileId,
      activeTabGroupId: window.activeTabGroupId,
      ...windowState(window.state),
    };
  }
}
