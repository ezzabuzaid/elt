import type { PlistValue } from '@workspace/sdk-apple-plist';

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

export type ClosedWindow = {
  readonly id: string | null;
  readonly position: number;
  readonly profileId: string | null;
  readonly activeTabGroupId: string | null;
  readonly state: WindowState;
  readonly activeTabs: ClosedWindowActiveTab[];
};

// A closed tab: on its own in the list, or one of a closed window's tabs.
export type ClosedTab = {
  readonly id: string | null;
  // The closed window it was one of; null for a tab closed on its own.
  readonly closedWindowId: string | null;
  readonly position: number;
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
  readonly closedWindowId: PlistValue | undefined;
  readonly position: number;
};

const windowType = 1;

const closedWindow = ({ state, position }: Entry): ClosedWindow => ({
  id: stored(state.WindowUUID),
  position,
  profileId: stored(state.ProfileUUID),
  activeTabGroupId: text(state.activeTabGroupUUID),
  state: windowState(state),
  activeTabs: Object.entries(dictionary(state.TabGroupsToActiveTabs)).map(
    ([tabGroupId, tabId]) => ({ tabGroupId, tabId: stored(tabId) }),
  ),
});

const closedTab = ({ state, closedWindowId, position }: Entry): ClosedTab => ({
  id: stored(state.TabUUID),
  closedWindowId: stored(closedWindowId),
  position,
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
// date order; a window or tab listed again keeps the entry it was last
// closed in.
export class RecentlyClosed {
  readonly #entries: readonly PlistValue[];

  constructor(plist: PlistValue) {
    const entries = dictionary(plist).ClosedTabOrWindowPersistentStates;
    if (!Array.isArray(entries))
      throw new TypeError('RecentlyClosedTabs.plist lists no closed entries');
    this.#entries = entries;
  }

  // The entries keep() keeps, before a later closing replaces an earlier
  // one, so a tab closed under two profiles keeps the kept profile's entry.
  closed(keep: ClosedEntryFilter): {
    readonly windows: ClosedWindow[];
    readonly tabs: ClosedTab[];
  } {
    const windows = new Map<unknown, Entry>();
    const tabs = new Map<unknown, Entry>();
    this.#entries.forEach((value, position) => {
      const entry = dictionary(value);
      const state = dictionary(entry.PersistentState);
      if (!keep(stored(state.ProfileUUID))) return;
      if (entry.PersistentStateType !== windowType) {
        latest(tabs, state.TabUUID, { state, closedWindowId: null, position });
        return;
      }
      latest(windows, state.WindowUUID, {
        state,
        closedWindowId: undefined,
        position,
      });
      for (const [index, tab] of list(state.TabStates).entries())
        latest(tabs, dictionary(tab).TabUUID, {
          state: dictionary(tab),
          closedWindowId: state.WindowUUID,
          position: index,
        });
    });
    return {
      windows: [...windows.values()].map(closedWindow),
      tabs: [...tabs.values()].map(closedTab),
    };
  }
}

function latest(entries: Map<unknown, Entry>, id: unknown, entry: Entry): void {
  const kept = entries.get(id);
  const closed = (candidate: Entry) =>
    candidate.state.DateClosed instanceof Date
      ? candidate.state.DateClosed.getTime()
      : Number.NEGATIVE_INFINITY;
  if (kept === undefined || closed(entry) > closed(kept))
    entries.set(id, entry);
}
