import { ClosedWorld } from '@zukhruf/snapshot-differential';

import {
  type Properties,
  type RecordDraft,
  type SourceMessage,
  diffSnapshot,
} from '@workspace/elt';

import type { InstagramRun, LaneReader } from './instagram-run.ts';
import {
  type DateRange,
  InstagramStream,
  type ReadContext,
} from './instagram-stream.ts';
import { walk } from './list-walk.ts';
import { readLane, readScan } from './state.ts';

// A stream of one of a profile's lists, scanned in parts: each page a run
// reads is one part of the scan, committed on its own; edits show at once,
// and the part that reaches the list's end deletes what no part listed.
export abstract class ListStream<
  P extends Properties,
  Item,
> extends InstagramStream<P> {
  protected abstract reader(run: InstagramRun): LaneReader<Item>;

  protected abstract record(item: Item, profileId: string): RecordDraft<P>;

  // Ends the list at the first unpinned item older than the range's start,
  // for a list whose items say when they were posted.
  protected olderThan(
    _range: DateRange,
  ): ((item: Item) => boolean) | undefined {
    return undefined;
  }

  protected inRange(_item: Item, _range: DateRange): boolean {
    return true;
  }

  async *read({
    run,
    state,
    profileId,
    range,
    signal,
  }: ReadContext): AsyncGenerator<SourceMessage> {
    if (profileId === null)
      throw new TypeError(`Instagram's ${this.name} stream reads a profile`);
    const profile = await run.profile(profileId, signal);
    const reader = this.reader(run);
    const saved = readScan(this.name, state);
    const stream = this.describe();
    let diff = saved.diff;
    for await (const part of walk(
      reader,
      profile,
      readLane(this.name, saved.lanes[reader.lane.name]),
      signal,
      this.olderThan(range),
    )) {
      const items = new Map(
        part.items
          .filter((item) => this.inRange(item, range))
          .map((item) => [reader.lane.id(item), item]),
      );
      const records = this.validated(
        [...items.values()].map((item) => this.record(item, profileId)),
      );
      const lane = part.ends ? { ...part.lane, ended: false } : part.lane;
      for await (const message of diffSnapshot(stream, records, diff, {
        policy: new ClosedWorld(),
        continues: !part.ends,
      }))
        if ('type' in message && message.type === 'STATE') {
          diff = message.state;
          yield {
            ...message,
            state: { lanes: { [reader.lane.name]: lane }, diff },
          };
        } else yield message;
    }
  }
}
