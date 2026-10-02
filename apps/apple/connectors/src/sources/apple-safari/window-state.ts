import type { SchemaRecord } from '@workspace/elt';

import { safariFields } from './safari-stream.ts';
import {
  type Dictionary,
  flag,
  integer,
  plistTime,
  strings,
  text,
} from './safari-values.ts';

const { boolean, nullableText, nullableInteger } = safariFields;

// What Safari keeps of a window's state, open or recently closed.
export const windowStateFields = {
  closedAt: {
    ...safariFields.nullableTimestamp,
    description: 'When the window was closed; NULL while it is open.',
  },
  private: { ...boolean, description: 'Whether it is a private window.' },
  popup: { ...boolean, description: 'Whether it is a popup window.' },
  miniaturized: {
    ...boolean,
    description: 'Whether it is minimized to the Dock.',
  },
  unnamedTabGroupIds: {
    type: 'array',
    items: { type: 'string' },
    description: 'Unnamed tab groups of the window.',
  },
  selectedTabIndex: {
    ...nullableInteger,
    description: 'Index of the selected tab; NULL when not recorded.',
  },
  selectedPinnedTabIndex: {
    ...nullableInteger,
    description:
      'Index of the selected pinned tab; NULL when no pinned tab is selected.',
  },
  tabBarHidden: { ...boolean, description: 'Whether the tab bar is hidden.' },
  favoritesBarHidden: {
    ...boolean,
    description: 'Whether the Favorites bar is hidden.',
  },
  readingListSidebarVisible: {
    ...boolean,
    description: 'Whether the window prefers the Reading List sidebar.',
  },
  sidebarMode: {
    ...nullableInteger,
    description: 'Safari sidebar mode code, as stored; NULL when not recorded.',
  },
  frame: {
    ...nullableText,
    description:
      'Window content rectangle as Safari stores it, "{{x, y}, {width, height}}"; NULL when not recorded.',
  },
  addressFieldText: {
    ...nullableText,
    description:
      'Text typed into the address field and not yet submitted; NULL when none.',
  },
} as const;

export const windowState = (
  state: Dictionary,
): SchemaRecord<typeof windowStateFields> => ({
  closedAt: plistTime(state.DateClosed),
  private: flag(state.IsPrivateWindow),
  popup: flag(state.IsPopupWindow),
  miniaturized: flag(state.Miniaturized),
  unnamedTabGroupIds: strings(state.UnnamedTabGroupUUIDs),
  selectedTabIndex: integer(state.SelectedTabIndex),
  selectedPinnedTabIndex: integer(state.SelectedPinnedTabIndex),
  tabBarHidden: flag(state.TabBarHidden),
  favoritesBarHidden: flag(state.FavoritesBarHidden),
  readingListSidebarVisible: flag(state.PrefersReadingListSidebarVisible),
  sidebarMode: integer(state.WindowUnifiedSidebarMode),
  frame: text(state.WindowContentRect),
  addressFieldText: text(state.CustomUnifiedFieldText),
});
