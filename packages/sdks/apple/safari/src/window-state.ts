import {
  type Dictionary,
  flag,
  integer,
  plistTime,
  strings,
  text,
} from './safari-values.ts';

// What Safari keeps of a window's state, open or recently closed.
export type WindowState = {
  readonly closedAt: Date | null;
  readonly private: boolean;
  readonly popup: boolean;
  readonly miniaturized: boolean;
  readonly unnamedTabGroupIds: string[];
  readonly selectedTabIndex: number | null;
  readonly selectedPinnedTabIndex: number | null;
  readonly tabBarHidden: boolean;
  readonly favoritesBarHidden: boolean;
  readonly readingListSidebarVisible: boolean;
  readonly sidebarMode: number | null;
  // The window's content rectangle, "{{x, y}, {width, height}}".
  readonly frame: string | null;
  // Text typed into the address field and not yet submitted.
  readonly addressFieldText: string | null;
};

export const windowState = (state: Dictionary): WindowState => ({
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
