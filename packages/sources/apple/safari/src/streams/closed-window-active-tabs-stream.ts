import type { RecordDraft } from '@eltjs/elt';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';

const properties = {
  windowPosition: {
    ...safariFields.ordinal,
    description: 'The closed window; refers to closedWindows.position.',
  },
  tabGroupId: {
    ...safariFields.id,
    description: 'A tab group the window showed.',
  },
  tabId: {
    ...safariFields.id,
    description:
      'The tab that was active in that group; closedTabs.tabId when Safari kept the tab.',
  },
} as const;

type Entry = {
  readonly windowPosition: number;
  readonly tabGroupId: string;
  readonly tabId: string | null;
};

export class ClosedWindowActiveTabsStream extends SafariStream<
  typeof properties,
  Entry
> {
  readonly name = 'closedWindowActiveTabs';
  readonly store = 'closedTabs';
  readonly primaryKey = ['windowPosition', 'tabGroupId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per tab group of a recently closed window, naming the tab active in it (RecentlyClosedTabs.plist TabGroupsToActiveTabs). Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly Entry[] {
    return scan.closedTabs.windows.flatMap((window) =>
      window.activeTabs.map(({ tabGroupId, tabId }) => ({
        windowPosition: window.position,
        tabGroupId,
        tabId,
      })),
    );
  }

  protected record(entry: Entry): RecordDraft<typeof properties> {
    return entry;
  }
}
