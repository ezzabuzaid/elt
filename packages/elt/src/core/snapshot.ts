import { scheduler } from 'node:timers/promises';

import {
  DeletionPolicy,
  type KeptGroup,
  type SnapshotChange,
  SnapshotDifferential,
  type SnapshotGroup,
  type Verdict,
} from '@zukhruf/snapshot-differential';

import type { CopyConfiguration } from './copy-configuration.ts';
import { Deduplication } from './deduplication.ts';
import type { DeleteMessage, StateMessage } from './source.ts';
import type { Stream } from './stream.ts';

// A group the source lists without reading, because it knows the group did not change.
export type { KeptGroup };

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
  // The run's signal, as the extract receives it. A diff that finds nothing
  // changed yields no message for the run to stop at, so it stops itself at
  // the next record or group once the run is cancelled.
  readonly signal: AbortSignal | undefined;
};

type SnapshotMessage<Data> =
  | { readonly stream: string; readonly data: Data }
  | DeleteMessage
  | StateMessage;

// Reads for a source without a change feed. An incremental copy compares one
// complete scan with the previous snapshot, emits new or changed records, a
// DELETE for every vanished key the policy judges deleted, then the new
// snapshot as the only STATE. A full refresh replaces its target, so it emits
// every record of the scan, one at a time as the scan yields it, and saves
// nothing. rereads names the lookback window of a scan the next one repeats
// only in part; continues makes the call one part of a scan.
export async function* diffSnapshot<Data extends Record<string, unknown>>(
  { stream, syncMode }: CopyConfiguration,
  records: AsyncIterable<Data> | Iterable<Data>,
  state: unknown,
  options: SnapshotDiffOptions & {
    readonly rereads?: (record: Data) => boolean;
  },
): AsyncGenerator<SnapshotMessage<Data>> {
  const differential = differentialOf<Data>(stream, options);
  if (syncMode !== 'incremental') {
    for await (const data of records) yield { stream: stream.name, data };
    return;
  }
  for await (const change of differential.diff(
    untilStopped(records, options.signal),
    state,
    options,
  ))
    yield messageOf(stream, change);
}

// diffSnapshot for a scan whose records come from inputs the source can
// fingerprint cheaply: in an incremental copy, a group whose fingerprint
// matches the last committed scan, and a kept group, which the source knows
// did not change, keep their records without reading them.
export async function* diffGroupedSnapshot<
  Data extends Record<string, unknown>,
>(
  { stream, syncMode }: CopyConfiguration,
  groups:
    | AsyncIterable<SnapshotGroup<Data> | KeptGroup>
    | Iterable<SnapshotGroup<Data> | KeptGroup>,
  state: unknown,
  options: SnapshotDiffOptions,
): AsyncGenerator<SnapshotMessage<Data>> {
  const differential = differentialOf<Data>(stream, options);
  if (syncMode !== 'incremental') {
    for await (const group of groups) {
      // A full refresh replaces its target, so it must read every group.
      if ('kept' in group)
        throw new TypeError(
          `Stream ${stream.name} kept group ${group.key} in a full refresh, which reads every group`,
        );
      for await (const data of group.records())
        yield { stream: stream.name, data };
    }
    return;
  }
  for await (const change of differential.diffGroups(
    untilStopped(groups, options.signal),
    state,
    options,
  ))
    yield messageOf(stream, change);
}

// Each item of a scan until signal aborts. A scan that finds nothing changed
// may never wait on I/O, and then no other task runs until it ends: not the
// host's stop, its timers nor the requests it serves. So the scan gives the
// event loop a turn every turnMs, and once the run is cancelled it ends with
// the signal's reason, never as a complete scan the differential could
// delete the unread keys of.
async function* untilStopped<Item>(
  items: AsyncIterable<Item> | Iterable<Item>,
  signal: AbortSignal | undefined,
): AsyncGenerator<Item> {
  let turn = performance.now();
  for await (const item of items) {
    if (performance.now() - turn > turnMs) {
      await scheduler.yield();
      turn = performance.now();
    }
    signal?.throwIfAborted();
    yield item;
  }
}

// The longest a scan runs without letting another task run.
const turnMs = 10;

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
