import { Deduplication } from './deduplication.ts';
import type { KeyValue } from './source.ts';
import type { Stream } from './stream.ts';

// One slice of a partitioned stream: a value for every partitionKey field.
export type Partition = Readonly<Record<string, KeyValue>>;

export type PartitionState = {
  readonly partition: Partition;
  readonly state: unknown;
};

// The partitionKey fields reuse deduplication's scalar key rules and encoding.
export function partitionIdentity(stream: Stream): Deduplication {
  if (stream.partitionKey === undefined)
    throw new TypeError(`Stream ${stream.name} is not partitioned`);
  return new Deduplication(stream, stream.partitionKey);
}

export function assertPartitions(
  stream: Stream,
  partitions: readonly Partition[],
): void {
  const identity = partitionIdentity(stream);
  if (!Array.isArray(partitions) || partitions.length === 0)
    throw new TypeError(
      `Stream ${stream.name} requires at least one partition`,
    );
  const keys = new Set<string>();
  for (const partition of partitions) {
    const { key } = readPartition(identity, partition);
    if (keys.has(key))
      throw new TypeError(`Stream ${stream.name} lists partition ${key} twice`);
    keys.add(key);
  }
}

// Exactly the partitionKey fields, each a valid non-null scalar.
export function readPartition(
  identity: Deduplication,
  value: unknown,
): { readonly key: string; readonly partition: Partition } {
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.keys(value).length !== identity.primaryKey.length
  )
    throw new TypeError(
      `Stream ${identity.stream.name} partitions carry exactly ${JSON.stringify(identity.primaryKey)}`,
    );
  return {
    key: identity.key(value),
    partition: Object.freeze(
      Object.fromEntries(
        identity.primaryKey.map((field) => [
          field,
          identity.value(value, field),
        ]),
      ),
    ),
  };
}

// Every record and deletion names the partition it was read for, so a
// connector cannot load rows without, or under the wrong, partition value.
export function assertInPartition(
  stream: Stream,
  partition: Partition,
  value: unknown,
): void {
  for (const [field, expected] of Object.entries(partition)) {
    const actual: unknown =
      value !== null && typeof value === 'object'
        ? Reflect.get(value, field)
        : undefined;
    if (actual !== expected)
      throw new TypeError(
        `Stream ${stream.name} record for partition ${JSON.stringify(partition)} carries ${field} ${JSON.stringify(actual)}`,
      );
  }
}

// The checkpoint of a partitioned stream: each partition's own source state.
export function readPartitionStates(
  stream: Stream,
  state: unknown,
): Map<string, PartitionState> {
  const saved = new Map<string, PartitionState>();
  if (state === null) return saved;
  const invalid = () =>
    new TypeError(`Invalid partitioned checkpoint for stream ${stream.name}`);
  const entries: unknown =
    state !== null && typeof state === 'object' && !Array.isArray(state)
      ? Reflect.get(state, 'partitions')
      : undefined;
  if (Object.keys(state ?? {}).length !== 1 || !Array.isArray(entries))
    throw invalid();
  const identity = partitionIdentity(stream);
  for (const entry of entries) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Object.keys(entry).length !== 2 ||
      !Object.hasOwn(entry, 'state')
    )
      throw invalid();
    let read: ReturnType<typeof readPartition>;
    try {
      read = readPartition(identity, Reflect.get(entry, 'partition'));
    } catch {
      throw invalid();
    }
    if (saved.has(read.key)) throw invalid();
    saved.set(read.key, {
      partition: read.partition,
      state: Reflect.get(entry, 'state'),
    });
  }
  return saved;
}
