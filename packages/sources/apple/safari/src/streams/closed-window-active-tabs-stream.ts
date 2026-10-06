import type { RecordDraft } from '@workspace/elt';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';

const properties = {
  windowId: {
    ...safariFields.id,
    description: 'The closed window; refers to closedWindows.id.',
  },
  tabGroupId: {
    ...safariFields.id,
    description: 'A tab group the window showed.',
  },
  tabId: {
    ...safariFields.id,
    description:
      'The tab that was active in that group; closedTabs.id when Safari kept the tab.',
  },
} as const;

type Entry = {
  readonly windowId: string | null;
  readonly tabGroupId: string;
  readonly tabId: string | null;
};

export class ClosedWindowActiveTabsStream extends SafariStream<
  typeof properties,
  Entry
> {
  readonly name = 'closedWindowActiveTabs';
  readonly store = 'closedTabs';
  readonly primaryKey = ['windowId', 'tabGroupId'];
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
        windowId: window.id,
        tabGroupId,
        tabId,
      })),
    );
  }

  protected record(entry: Entry): RecordDraft<typeof properties> {
    return entry;
  }
}
