import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Deduplication } from './deduplication.ts';
import type { DeleteMessage, KeyValue, StateMessage } from './source.ts';
import type { Stream } from './stream.ts';

// Each key (the JSON of its primaryKey values) mapped to a fingerprint of the
// record it identified in the last committed scan.
export type SnapshotState = {
  readonly snapshot: Readonly<Record<string, string>>;
};

// Incremental reads for a source without a change feed: compare one complete
// scan with the previous snapshot, emit new or changed records, a DELETE for
// every key that vanished, then the new snapshot as the only STATE.
// An empty scan deletes everything, so a failed read must throw, never yield nothing.
export async function* diffSnapshot<Data extends Record<string, unknown>>(
  stream: Stream,
  records: AsyncIterable<Data> | Iterable<Data>,
  state: unknown,
): AsyncGenerator<
  | { readonly stream: string; readonly data: Data }
  | DeleteMessage
  | StateMessage
> {
  assertSnapshotStream(stream);
  const deduplication = new Deduplication(stream, stream.primaryKey);
  const previous = readSnapshot(state);
  const current = new Map<string, string>();
  for await (const data of records) {
    const key = deduplication.key(data);
    if (current.has(key))
      throw new TypeError(
        `Stream ${stream.name} returned key ${key} twice in one scan`,
      );
    const fingerprint = fingerprintOf(stream, data);
    current.set(key, fingerprint);
    if (previous.get(key) !== fingerprint) yield { stream: stream.name, data };
  }
  for (const key of previous.keys())
    if (!current.has(key))
      yield {
        type: 'DELETE',
        stream: stream.name,
        key: keyObject(stream, key),
      };
  const snapshot = sortedObject(current);
  yield { type: 'STATE', stream: stream.name, state: { snapshot } };
}

// The records one input produced (a file, a message), keyed by that input,
// with a fingerprint the source computes without reading the input.
export type SnapshotGroup<Data> = {
  readonly key: string;
  // null when the source cannot vouch for the input: it is always read.
  readonly fingerprint: string | null;
  records(): AsyncIterable<Data> | Iterable<Data>;
};

type SavedGroup = {
  readonly fingerprint: string | null;
  readonly snapshot: Readonly<Record<string, string>>;
};

// Each group's input fingerprint and the snapshot of the records it produced.
export type GroupedSnapshotState = {
  readonly groups: Readonly<Record<string, SavedGroup>>;
};

// diffSnapshot for a scan whose records come from inputs the source can
// fingerprint cheaply. A group whose fingerprint matches the last committed
// scan keeps its records without reading them; every other group is read and
// diffed record by record. Deletions still come from the complete scan: a key
// no group produced, carried or read, is deleted.
export async function* diffGroupedSnapshot<
  Data extends Record<string, unknown>,
>(
  stream: Stream,
  groups: AsyncIterable<SnapshotGroup<Data>> | Iterable<SnapshotGroup<Data>>,
  state: unknown,
): AsyncGenerator<
  | { readonly stream: string; readonly data: Data }
  | DeleteMessage
  | StateMessage
> {
  assertSnapshotStream(stream);
  const deduplication = new Deduplication(stream, stream.primaryKey);
  const previous = new Map(
    Object.entries((state as GroupedSnapshotState | null)?.groups ?? {}),
  );
  // A record can move between groups; its previous fingerprint is then found
  // through every previous group, indexed only when a lookup misses.
  let everyPrevious: Map<string, string> | null = null;
  const previousFingerprint = (group: SavedGroup | undefined, key: string) => {
    const same = group?.snapshot[key];
    if (same !== undefined) return same;
    everyPrevious ??= new Map(
      [...previous.values()].flatMap(({ snapshot }) =>
        Object.entries(snapshot),
      ),
    );
    return everyPrevious.get(key);
  };
  const seen = new Set<string>();
  const claim = (key: string) => {
    if (seen.has(key))
      throw new TypeError(
        `Stream ${stream.name} returned key ${key} twice in one scan`,
      );
    seen.add(key);
  };
  const current = new Map<string, SavedGroup>();
  for await (const group of groups) {
    if (current.has(group.key))
      throw new TypeError(
        `Stream ${stream.name} returned group ${group.key} twice in one scan`,
      );
    const before = previous.get(group.key);
    if (
      group.fingerprint !== null &&
      before?.fingerprint === group.fingerprint
    ) {
      for (const key of Object.keys(before.snapshot)) claim(key);
      current.set(group.key, before);
      continue;
    }
    const snapshot = new Map<string, string>();
    for await (const data of group.records()) {
      const key = deduplication.key(data);
      claim(key);
      const fingerprint = fingerprintOf(stream, data);
      snapshot.set(key, fingerprint);
      if (previousFingerprint(before, key) !== fingerprint)
        yield { stream: stream.name, data };
    }
    current.set(group.key, {
      fingerprint: group.fingerprint,
      snapshot: sortedObject(snapshot),
    });
  }
  for (const { snapshot } of previous.values())
    for (const key of Object.keys(snapshot))
      if (!seen.has(key))
        yield {
          type: 'DELETE',
          stream: stream.name,
          key: keyObject(stream, key),
        };
  yield {
    type: 'STATE',
    stream: stream.name,
    state: { groups: sortedObject(current) },
  };
}

function assertSnapshotStream(stream: Stream): void {
  if (!stream.sourceDefinedCursor || !stream.emitsDeletes)
    throw new TypeError(
      `Stream ${stream.name} must declare sourceDefinedCursor and emitsDeletes to diff snapshots`,
    );
}

// Sorted by key, so equal scans save byte-identical state.
function sortedObject<Value>(
  entries: ReadonlyMap<string, Value>,
): Record<string, Value> {
  return Object.fromEntries(
    [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

// The previous snapshot, as diffSnapshot wrote it.
function readSnapshot(state: unknown): Map<string, string> {
  return new Map(
    Object.entries((state as SnapshotState | null)?.snapshot ?? {}),
  );
}

// A snapshot key is the JSON of the primary key's values, in field order.
function keyObject(stream: Stream, key: string): Record<string, KeyValue> {
  const values = JSON.parse(key) as KeyValue[];
  return Object.fromEntries(
    values.map((value, index) => [stream.primaryKey[index] as string, value]),
  );
}

function fingerprintOf(
  stream: Stream,
  record: Record<string, unknown>,
): string {
  const serialized: unknown = JSON.parse(JSON.stringify(record));
  if (!isDeepStrictEqual(serialized, record))
    throw new TypeError(
      `Stream ${stream.name} records must be losslessly JSON serializable to diff snapshots`,
    );
  return createHash('sha256').update(canonical(serialized)).digest('base64url');
}

// JSON with object keys sorted at every depth, so equal records hash equally.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
