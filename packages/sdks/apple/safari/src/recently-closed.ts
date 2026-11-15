import type { PlistValue } from '@eltjs/codec-plist';

import {
  type Dictionary,
  dictionary,
  flag,
  integer,
  list,
  plistTime,
  stored,
  strings,
  text,
} from './safari-values.ts';
import { type WindowState, windowState } from './window-state.ts';

// The tab a closed window showed in one of its tab groups.
export type ClosedWindowActiveTab = {
  readonly tabGroupId: string;
  readonly tabId: string | null;
};

// A closed window, identified by its place in the Recently Closed list:
// Safari lists a window again each time it closes it.
export type ClosedWindow = {
  readonly position: number;
  readonly windowId: string | null;
  readonly profileId: string | null;
  readonly activeTabGroupId: string | null;
  readonly state: WindowState;
  readonly activeTabs: ClosedWindowActiveTab[];
};

// A closed tab: on its own in the list, or one of a closed window's tabs,
// identified by the place of its entry in the list and its place among the
// entry's tabs.
export type ClosedTab = {
  // The place in the list of the tab closed on its own, or of the closed
  // window it was one of.
  readonly entryPosition: number;
  // Its place among its closed window's tabs; 0 for a tab closed on its own.
  readonly position: number;
  readonly tabId: string | null;
  readonly windowId: string | null;
  readonly profileId: string | null;
  readonly title: string | null;
  readonly url: string | null;
  readonly closedAt: Date | null;
  readonly lastVisitedAt: Date | null;
  readonly tabIndex: number | null;
  readonly tabGroupId: string | null;
  readonly tabGroupType: boolean;
  readonly ancestorTabIds: string[];
  readonly muted: boolean;
  readonly disposable: boolean;
  readonly safeToLoad: boolean;
};

// Which entries a reader keeps, by the profile each was closed in.
export type ClosedEntryFilter = (profileId: string | null) => boolean;

type Entry = {
  readonly state: Dictionary;
  readonly entryPosition: number;
  readonly position: number;
};

const windowType = 1;

const closedWindow = (state: Dictionary, position: number): ClosedWindow => ({
  position,
  windowId: stored(state.WindowUUID),
  profileId: stored(state.ProfileUUID),
  activeTabGroupId: text(state.activeTabGroupUUID),
  state: windowState(state),
  activeTabs: Object.entries(dictionary(state.TabGroupsToActiveTabs)).map(
    ([tabGroupId, tabId]) => ({ tabGroupId, tabId: stored(tabId) }),
  ),
});

const closedTab = ({ state, entryPosition, position }: Entry): ClosedTab => ({
  entryPosition,
  position,
  tabId: stored(state.TabUUID),
  windowId: text(state.WindowUUID),
  profileId: stored(state.ProfileUUID),
  title: text(state.TabTitle),
  url: text(state.TabURL),
  closedAt: plistTime(state.DateClosed),
  lastVisitedAt: plistTime(state.LastVisitTime),
  tabIndex: integer(state.TabIndex),
  tabGroupId: text(state.TabGroupForTab),
  tabGroupType: flag(state.TabGroupTypeForTabKey),
  ancestorTabIds: strings(state.AncestorTabUUIDsKey),
  muted: flag(state.IsMuted),
  disposable: flag(state.IsDisposable),
  safeToLoad: flag(state.SafeToLoad),
});

// RecentlyClosedTabs.plist: what History > Recently Closed lists, windows
// with the tabs they held and tabs closed on their own. The list is in no
// date order, and it lists a window or tab again each time Safari closes it.
export class RecentlyClosed {
  readonly #entries: readonly PlistValue[];

  constructor(plist: PlistValue) {
    const entries = dictionary(plist).ClosedTabOrWindowPersistentStates;
    if (!Array.isArray(entries))
      throw new TypeError('RecentlyClosedTabs.plist lists no closed entries');
    this.#entries = entries;
  }

  // The entries keep() keeps, each at its place in the list.
  closed(keep: ClosedEntryFilter): {
    readonly windows: ClosedWindow[];
    readonly tabs: ClosedTab[];
  } {
    const windows: ClosedWindow[] = [];
    const tabs: ClosedTab[] = [];
    this.#entries.forEach((value, entryPosition) => {
      const entry = dictionary(value);
      const state = dictionary(entry.PersistentState);
      if (!keep(stored(state.ProfileUUID))) return;
      if (entry.PersistentStateType !== windowType) {
        tabs.push(closedTab({ state, entryPosition, position: 0 }));
        return;
      }
      windows.push(closedWindow(state, entryPosition));
      for (const [position, tab] of list(state.TabStates).entries())
        tabs.push(
          closedTab({ state: dictionary(tab), entryPosition, position }),
        );
    });
    return { windows, tabs };
  }
}
