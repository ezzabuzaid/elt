import {
  type Properties,
  type RecordDraft,
  type SourceMessage,
  diffSnapshot,
} from '@workspace/elt';
import {
  ClosedWorld,
  type DeletionPolicy,
} from '@workspace/snapshot-differential';

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
    const stream = this.describe();
    yield* this.withImages(
      context.incremental
        ? diffSnapshot(stream, valid, context.state, { policy: this.policy() })
        : valid.map((data) => ({ stream: stream.name, data })),
      images,
      context,
    );
  }
}
