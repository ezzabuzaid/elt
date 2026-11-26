import { setImmediate } from 'node:timers/promises';

import {
  DeletionPolicy,
  type FailedGroup,
  type GroupedSnapshot,
  type KeptGroup,
  type SnapshotChange,
  SnapshotDifferential,
  type SnapshotGroup,
  type Verdict,
} from '@zukhruf/snapshot-differential';

import type { CopyConfiguration } from './copy-configuration.ts';
import { Deduplication } from './deduplication.ts';
import type {
  SavedEntries,
  StateMessage,
  UnversionedDelete,
} from './source.ts';
import type { Stream } from './stream.ts';

// A group the source lists without reading, because it knows the group did
// not change; and one it could not read, which keeps what the snapshot has.
export type { FailedGroup, KeptGroup };

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

type RowMessage<Data> =
  { readonly stream: string; readonly data: Data } | UnversionedDelete;

type SnapshotMessage<Data> = RowMessage<Data> | StateMessage;

// Reads for a source without a change feed. An incremental copy compares one
// complete scan with the previous snapshot, emits new or changed records, a
// DELETE for every vanished key the policy judges deleted, then the new
// snapshot as the only STATE. A full refresh replaces its target, so it emits
// every record of the scan, one at a time as the scan yields it, and saves
// nothing. rereads names the lookback window of a scan the next one repeats
// only in part; continues makes the call one part of a scan.
export function diffSnapshot<Data extends Record<string, unknown>>(
  configuration: CopyConfiguration,
  records: AsyncIterable<Data> | Iterable<Data>,
  state: unknown,
  options: SnapshotDiffOptions & {
    readonly rereads?: (record: Data) => boolean;
  },
): AsyncGenerator<SnapshotMessage<Data>> {
  return diffVersionedSnapshot(configuration, records, state, options);
}

// diffSnapshot that compares each record by what fingerprint gives for it,
// such as the host's version of the row, in place of the hash of its
// content. A record whose fingerprint did not change keeps its row, also
// when its content changed.
export async function* diffVersionedSnapshot<
  Data extends Record<string, unknown>,
>(
  { stream, syncMode }: CopyConfiguration,
  records: AsyncIterable<Data> | Iterable<Data>,
  state: unknown,
  options: SnapshotDiffOptions & {
    readonly rereads?: (record: Data) => boolean;
    readonly fingerprint?: ((record: Data) => string) | undefined;
  },
): AsyncGenerator<SnapshotMessage<Data>> {
  const deduplication = deduplicationOf(stream);
  const differential = differentialOf<Data>(
    deduplication,
    policyOf(stream, options.policy),
    options.fingerprint,
  );
  if (syncMode !== 'incremental') {
    for await (const data of records) yield { stream: stream.name, data };
    return;
  }
  for await (const change of differential.diff(
    untilStopped(records, options.signal),
    state,
    options,
  ))
    yield change.type === 'state'
      ? { type: 'STATE', stream: stream.name, state: change.state }
      : messageOf(deduplication, change);
}

// The STATE of a grouped snapshot diff: what changed in each collection of
// the snapshot, as the changes of its keyed entries, and the new snapshot,
// for the next call of the same extract. state is null: the snapshot is in
// the entries (ADR 0036).
export type GroupedSnapshotState = StateMessage & {
  readonly state: null;
  readonly snapshot: GroupedSnapshot;
};

type GroupedSnapshotMessage<Data> = RowMessage<Data> | GroupedSnapshotState;

// The spaces of the checkpoint's entries that keep a grouped snapshot, one
// for each of its keyed collections. elt scopes them to the stream, or to
// the partition, of the extract (ADR 0035).
const spaces = {
  groups: 'diff',
  unknown: 'diff:unknown',
  listed: 'diff:listed',
} as const;

// The grouped snapshot that the last STATE of the stream, or of the
// partition, saved in entries; empty before the first scan. The differential
// checks each entry as it reads it back.
export async function resumeGroupedSnapshot(
  { stream }: CopyConfiguration,
  entries: SavedEntries,
): Promise<GroupedSnapshot> {
  const [groups, unknown, listed] = await Promise.all([
    entries.space(spaces.groups),
    entries.space(spaces.unknown),
    entries.space(spaces.listed),
  ]);
  // savedGroups reads only the name of the differential, so the policy of
  // the diff is not needed here.
  return differentialOf(deduplicationOf(stream), new Forgetting()).savedGroups({
    groups,
    unknown,
    listed,
  });
}

// diffSnapshot for a scan whose records come from inputs the source can
// fingerprint cheaply: in an incremental copy, a group whose fingerprint
// matches snapshot, and a kept group, which the source knows did not
// change, keep their records without reading them. snapshot is what
// resumeGroupedSnapshot gives, or the snapshot of the last STATE of this
// extract; each STATE puts and removes only the entries that changed.
export async function* diffGroupedSnapshot<
  Data extends Record<string, unknown>,
>(
  { stream, syncMode }: CopyConfiguration,
  groups:
    | AsyncIterable<SnapshotGroup<Data> | KeptGroup | FailedGroup>
    | Iterable<SnapshotGroup<Data> | KeptGroup | FailedGroup>,
  snapshot: GroupedSnapshot,
  options: SnapshotDiffOptions,
): AsyncGenerator<GroupedSnapshotMessage<Data>> {
  const deduplication = deduplicationOf(stream);
  const differential = differentialOf<Data>(
    deduplication,
    policyOf(stream, options.policy),
  );
  if (syncMode !== 'incremental') {
    for await (const group of groups) {
      // A failed group gives no records to replace the target with; its
      // failure fails the read, so the target keeps its last complete scan.
      if ('failed' in group) continue;
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
    snapshot,
    options,
  ))
    if (change.type !== 'state') yield messageOf(deduplication, change);
    else {
      const { changes } = change.state;
      yield {
        type: 'STATE',
        stream: stream.name,
        state: null,
        entries: {
          [spaces.groups]: changes.groups,
          [spaces.unknown]: changes.unknown,
          [spaces.listed]: changes.listed,
        },
        snapshot: change.state.snapshot,
      };
    }
}

// Each item of a scan until signal aborts. A scan that finds nothing changed
// may never wait on I/O, and then no other task runs until it ends: not the
// host's stop, its timers nor the requests it serves. So the scan gives the
// event loop a turn every turnItems items, and once the run is cancelled it
// ends with the signal's reason, never as a complete scan the differential
// could delete the unread keys of.
async function* untilStopped<Item>(
  items: AsyncIterable<Item> | Iterable<Item>,
  signal: AbortSignal | undefined,
): AsyncGenerator<Item> {
  let read = 0;
  for await (const item of items) {
    if (++read % turnItems === 0) await setImmediate();
    signal?.throwIfAborted();
    yield item;
  }
}

// The most items a scan reads without letting another task run. A count, not
// a time, so the turns do not depend on a clock: an item diffs in
// microseconds, so a turn comes within a few milliseconds.
const turnItems = 1000;

// A stream that declares no emitsDeletes has an upstream that forgets
// records rather than deleting them: every vanished key leaves the snapshot
// without a DELETE, and its row stays loaded.
class Forgetting extends DeletionPolicy {
  override vanished(): Verdict {
    return 'expired';
  }
}

function deduplicationOf(stream: Stream): Deduplication {
  if (!stream.sourceDefinedCursor)
    throw new TypeError(
      `Stream ${stream.name} must declare sourceDefinedCursor to diff snapshots`,
    );
  return new Deduplication(stream, stream.primaryKey);
}

function differentialOf<Data extends Record<string, unknown>>(
  deduplication: Deduplication,
  policy: DeletionPolicy,
  fingerprint?: (record: Data) => string,
): SnapshotDifferential<Data> {
  const { stream } = deduplication;
  return new SnapshotDifferential<Data>({
    name: stream.name,
    primaryKey: stream.primaryKey,
    key: (record) =>
      deduplication.primaryKey.map((field) =>
        deduplication.value(record, field),
      ),
    expiresBy: stream.expiresBy,
    policy,
    ...(fingerprint === undefined ? {} : { fingerprint }),
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

// The record or the DELETE of a change of the scan.
function messageOf<Data>(
  deduplication: Deduplication,
  change: Exclude<SnapshotChange<Data, unknown>, { readonly type: 'state' }>,
): RowMessage<Data> {
  const { stream } = deduplication;
  if (change.type !== 'delete')
    return { stream: stream.name, data: change.record };
  return {
    type: 'DELETE',
    stream: stream.name,
    // The differential can keep bytes in a key; a stream's key fields are
    // scalars, so the deleted key passes the same check its record did.
    key: Object.fromEntries(
      deduplication.primaryKey.map((field) => [
        field,
        deduplication.value(change.key, field),
      ]),
    ),
  };
}
