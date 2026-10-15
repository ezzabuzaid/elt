import type { Profile } from '@workspace/sdk-instagram-web';

import type { LaneReader } from './instagram-run.ts';

// Where a scan of one list stands between runs.
export type LaneState = {
  // The cursor of the next page the scan reads; null before its first page.
  readonly after: string | null;
  // The newest unpinned item of the last read of the list's top: a later
  // run reads new items from the top down to it.
  readonly head: string | null;
  // The scan reached the list's end and waits for the scan of another list
  // that shares its parts.
  readonly ended: boolean;
};

export const freshLane: LaneState = { after: null, head: null, ended: false };

// One page of a list as one part of a scan.
type Part<Item> = {
  readonly items: readonly Item[];
  // Where the scan stands once this part is committed.
  readonly lane: LaneState;
  // This part reached the end of the list.
  readonly ends: boolean;
};

// The parts one run reads of one list: first the items posted since the
// last run, from the top down to the last head, while a scan is under way;
// then the scan's next pages, until the list ends or the run's page budget
// for the list does. olderThan ends the list at the first unpinned item it
// accepts, for a date range's start.
export async function* walk<Item>(
  reader: LaneReader<Item>,
  profile: Profile,
  state: LaneState,
  signal: AbortSignal | undefined,
  olderThan?: (item: Item) => boolean,
): AsyncGenerator<Part<Item>> {
  const { lane } = reader;
  const unpinned = (items: readonly Item[]) =>
    items.filter((item) => !lane.pinned(item, profile));
  // A cursor Instagram gave twice would read the same pages forever.
  const followed = new Set<string>();
  const follow = (cursor: string | null) => {
    if (cursor === null) return;
    if (followed.has(cursor))
      throw new TypeError(
        `Instagram gave the ${lane.name} page cursor ${cursor} twice in one read`,
      );
    followed.add(cursor);
  };
  let current = state;
  if ((current.after !== null || current.ended) && current.head !== null) {
    let cursor: string | null = null;
    let newest: string | null = null;
    for (;;) {
      const read = reader.page(profile, cursor, signal);
      if (read === null) return;
      const page = await read;
      const top = unpinned(page.items);
      newest ??= top[0] === undefined ? null : lane.id(top[0]);
      const reached =
        page.next === null ||
        top.some((item) => lane.id(item) === current.head);
      yield {
        items: page.items,
        lane: reached ? { ...current, head: newest ?? current.head } : current,
        ends: false,
      };
      if (reached) {
        current = { ...current, head: newest ?? current.head };
        break;
      }
      follow(page.next);
      cursor = page.next;
    }
  }
  if (current.ended) return;
  followed.clear();
  let { after, head } = current;
  for (;;) {
    const read = reader.page(profile, after, signal);
    if (read === null) return;
    const page = await read;
    if (after === null) {
      const [newest] = unpinned(page.items);
      head = newest === undefined ? head : lane.id(newest);
    }
    const stop =
      olderThan === undefined
        ? -1
        : page.items.findIndex(
            (item) => !lane.pinned(item, profile) && olderThan(item),
          );
    const ends = page.next === null || stop !== -1;
    yield {
      items: stop === -1 ? page.items : page.items.slice(0, stop),
      lane: ends
        ? { after: null, head, ended: true }
        : { after: page.next, head, ended: false },
      ends,
    };
    if (ends) return;
    follow(page.next);
    after = page.next;
  }
}
