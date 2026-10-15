import {
  DeletionPolicy,
  type SnapshotChange,
  SnapshotDifferential,
  type SnapshotGroup,
  type Verdict,
} from '@workspace/snapshot-differential';

import { Deduplication } from './deduplication.ts';
import type { DeleteMessage, StateMessage } from './source.ts';
import type { Stream } from './stream.ts';

export type SnapshotDiffOptions = {
  // What a vanished key means. A stream that emits deletions names one, such
  // as ClosedWorld for a scan that lists every record, Retention for an
  // upstream that drops records past an age, or Coverage for a cache. A
  // stream that does not takes none.
  readonly policy?: DeletionPolicy;
  // This call lists one part of a scan that later calls go on with: it
  // deletes nothing, and the part that ends the scan deletes every key that
  // no part listed, for an upstream too large to list in one run.
  readonly continues?: boolean;
};

type SnapshotMessage<Data> =
  | { readonly stream: string; readonly data: Data }
  | DeleteMessage
  | StateMessage;

// Incremental reads for a source without a change feed: compare one complete
// scan with the previous snapshot, emit new or changed records, a DELETE for
// every vanished key the policy judges deleted, then the new snapshot as the
// only STATE. rereads names the lookback window of a scan the next one
// repeats only in part; continues makes the call one part of a scan.
export async function* diffSnapshot<Data extends Record<string, unknown>>(
  stream: Stream,
  records: AsyncIterable<Data> | Iterable<Data>,
  state: unknown,
  options: SnapshotDiffOptions & {
    readonly rereads?: (record: Data) => boolean;
  } = {},
): AsyncGenerator<SnapshotMessage<Data>> {
  const differential = differentialOf<Data>(stream, options);
  for await (const change of differential.diff(records, state, options))
    yield messageOf(stream, change);
}

// diffSnapshot for a scan whose records come from inputs the source can
// fingerprint cheaply: a group whose fingerprint matches the last committed
// scan keeps its records without reading them.
export async function* diffGroupedSnapshot<
  Data extends Record<string, unknown>,
>(
  stream: Stream,
  groups: AsyncIterable<SnapshotGroup<Data>> | Iterable<SnapshotGroup<Data>>,
  state: unknown,
  options: SnapshotDiffOptions = {},
): AsyncGenerator<SnapshotMessage<Data>> {
  const differential = differentialOf<Data>(stream, options);
  for await (const change of differential.diffGroups(groups, state, options))
    yield messageOf(stream, change);
}

// A stream that declares no emitsDeletes has an upstream that forgets
// records rather than deleting them: every vanished key leaves the snapshot
// without a DELETE, and its row stays loaded.
class Forgetting extends DeletionPolicy {
  override vanished(): Verdict {
    return 'expired';
  }
}

function differentialOf<Data extends Record<string, unknown>>(
  stream: Stream,
  { policy }: SnapshotDiffOptions,
): SnapshotDifferential<Data> {
  if (!stream.sourceDefinedCursor)
    throw new TypeError(
      `Stream ${stream.name} must declare sourceDefinedCursor to diff snapshots`,
    );
  const deduplication = new Deduplication(stream, stream.primaryKey);
  return new SnapshotDifferential<Data>({
    name: stream.name,
    primaryKey: stream.primaryKey,
    key: (record) => deduplication.key(record),
    expiresBy: stream.expiresBy,
    policy: policyOf(stream, policy),
  });
}

function policyOf(
  stream: Stream,
  policy: DeletionPolicy | undefined,
): DeletionPolicy {
  if (!stream.emitsDeletes) {
    if (policy !== undefined)
      throw new TypeError(
        `Stream ${stream.name} emits no deletions, so its snapshot diff takes no policy`,
      );
    return new Forgetting();
  }
  if (policy === undefined)
    throw new TypeError(
      stream.expiresBy === undefined
        ? `Stream ${stream.name} emits deletions, so its snapshot diff needs a policy, such as ClosedWorld`
        : `Stream ${stream.name} expires by ${stream.expiresBy}, so its snapshot diff needs a policy, such as Retention(horizon)`,
    );
  return policy;
}

function messageOf<Data>(
  stream: Stream,
  change: SnapshotChange<Data, unknown>,
): SnapshotMessage<Data> {
  if (change.type === 'upsert')
    return { stream: stream.name, data: change.record };
  if (change.type === 'delete')
    return { type: 'DELETE', stream: stream.name, key: change.key };
  return { type: 'STATE', stream: stream.name, state: change.state };
}
