import {
  ClosedWorld,
  type DeletionPolicy,
} from '@zukhruf/snapshot-differential';

import {
  type Properties,
  type RecordDraft,
  type SourceMessage,
  diffSnapshot,
} from '@workspace/elt';

import { InstagramStream, type ReadContext } from './instagram-stream.ts';

// Every record a read lists, and the image of each record that has one,
// keyed as keyOf keys the record.
export type Snapshot<P extends Properties> = {
  readonly records: readonly RecordDraft<P>[];
  readonly images?: ReadonlyMap<string, string>;
};

// A stream each run reads whole, as one scan: a profile, its stories, its
// highlights.
export abstract class SnapshotStream<
  P extends Properties,
> extends InstagramStream<P> {
  protected abstract scan(context: ReadContext): Promise<Snapshot<P>>;

  protected policy(): DeletionPolicy {
    return new ClosedWorld();
  }

  async *read(context: ReadContext): AsyncGenerator<SourceMessage> {
    const { records, images = new Map<string, string>() } =
      await this.scan(context);
    const valid = this.validated(records);
    yield* this.withImages(
      diffSnapshot(context.configuration, valid, context.state, {
        policy: this.policy(),
        signal: context.signal,
      }),
      images,
      context,
    );
  }
}
