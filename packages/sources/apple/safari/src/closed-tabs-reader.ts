import type { PlistValue } from '@workspace/macos-plist';
import {
  type ImportScope,
  selected,
} from '@workspace/source-apple-macos/import-scope';

import { type Dictionary, dictionary, list } from './safari-values.ts';

// A closed tab: on its own in the list, or one of a closed window's tabs.
// closedWindowId is the window's UUID as stored, which the stream validates.
export type ClosedTab = {
  readonly state: Dictionary;
  readonly closedWindowId: PlistValue | undefined;
  readonly position: number;
};

export type ClosedWindow = {
  readonly state: Dictionary;
  readonly position: number;
};

const windowType = 1;

// One run's read of RecentlyClosedTabs.plist: what History > Recently Closed
// lists, windows with the tabs they held and tabs closed on their own. The
// list is in no date order; a window or tab listed again keeps the entry it
// was last closed in. The scope's profiles select entries; dates do not.
export class ClosedTabsReader {
  readonly #windows = new Map<unknown, ClosedWindow>();
  readonly #tabs = new Map<unknown, ClosedTab>();

  constructor(plist: PlistValue, scope: ImportScope) {
    const entries = dictionary(plist).ClosedTabOrWindowPersistentStates;
    if (!Array.isArray(entries))
      throw new TypeError('RecentlyClosedTabs.plist lists no closed entries');
    entries.forEach((value, position) => {
      const entry = dictionary(value);
      const state = dictionary(entry.PersistentState);
      if (!selected(scope.collectionIds, state.ProfileUUID)) return;
      if (entry.PersistentStateType !== windowType) {
        latest(this.#tabs, state.TabUUID, {
          state,
          closedWindowId: null,
          position,
        });
        return;
      }
      latest(this.#windows, state.WindowUUID, { state, position });
      for (const [index, tab] of list(state.TabStates).entries())
        latest(this.#tabs, dictionary(tab).TabUUID, {
          state: dictionary(tab),
          closedWindowId: state.WindowUUID,
          position: index,
        });
    });
  }

  get windows(): ClosedWindow[] {
    return [...this.#windows.values()];
  }

  get tabs(): ClosedTab[] {
    return [...this.#tabs.values()];
  }
}

function latest<T extends { readonly state: Dictionary }>(
  entries: Map<unknown, T>,
  id: unknown,
  entry: T,
): void {
  const kept = entries.get(id);
  const closed = (candidate: T) =>
    candidate.state.DateClosed instanceof Date
      ? candidate.state.DateClosed.getTime()
      : Number.NEGATIVE_INFINITY;
  if (kept === undefined || closed(entry) > closed(kept))
    entries.set(id, entry);
}
