import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { Deduplication } from './deduplication.ts';
import { isTimestamp } from './formats/timestamp-format.ts';
import type { DeleteMessage, KeyValue, StateMessage } from './source.ts';
import type { Stream } from './stream.ts';

// What the last committed scan saw of one key: the fingerprint of its record,
// or, when the stream declares expiresBy, the fingerprint and the record's
// expiresBy timestamp.
type SavedEntry = string | readonly [fingerprint: string, expiresBy: string];

// Each key (the JSON of its primaryKey values) mapped to what the last
// committed scan saw of the record it identified.
export type SnapshotState = {
  readonly snapshot: Readonly<Record<string, SavedEntry>>;
};

// A key the last committed scan saw and this scan did not.
export type VanishedRecord = {
  readonly key: Readonly<Record<string, KeyValue>>;
  // The record's expiresBy timestamp as last seen, when the stream declares it.
  readonly expiresBy?: string;
};

export type SnapshotDiffOptions = {
  // Whether this scan vouches for a vanished record, so that it was deleted:
  // a record the scan does not cover leaves the snapshot without a DELETE,
  // and its row stays loaded. Without it, a scan covers every record.
  readonly covers?: (vanished: VanishedRecord) => boolean;
};

// What a scan of an upstream that drops records past an age covers: the
// records whose expiresBy is at or after the horizon it keeps records from.
// One that vanished earlier expired.
export function expiredAfter(
  horizon: string,
): (vanished: VanishedRecord) => boolean {
  if (!isTimestamp(horizon))
    throw new TypeError(`Expiry horizon ${horizon} is not a timestamp`);
  // Canonical UTC timestamps order as text.
  return ({ expiresBy }) => expiresBy === undefined || expiresBy >= horizon;
}

// Incremental reads for a source without a change feed: compare one complete
// scan with the previous snapshot, emit new or changed records, a DELETE for
// every key that vanished, then the new snapshot as the only STATE.
// An empty scan deletes everything, so a failed read must throw, never yield nothing.
// A scan that holds only part of its upstream, such as a cache, says which
// vanished records it covers; a stream that declares expiresBy must, through
// expiredAfter. A stream that does not declare emitsDeletes has an upstream
// that forgets records rather than deleting them: every vanished key leaves
// the snapshot without a DELETE, and its row stays loaded.
export async function* diffSnapshot<Data extends Record<string, unknown>>(
  stream: Stream,
  records: AsyncIterable<Data> | Iterable<Data>,
  state: unknown,
  options: SnapshotDiffOptions = {},
): AsyncGenerator<
  | { readonly stream: string; readonly data: Data }
  | DeleteMessage
  | StateMessage
> {
  assertSnapshotStream(stream);
  const deleted = deletion(stream, options);
  const deduplication = new Deduplication(stream, stream.primaryKey);
  const previous = readSnapshot(state);
  const current = new Map<string, SavedEntry>();
  for await (const data of records) {
    const key = deduplication.key(data);
    if (current.has(key))
      throw new TypeError(
        `Stream ${stream.name} returned key ${key} twice in one scan`,
      );
    const fingerprint = fingerprintOf(stream, data);
    current.set(key, entryOf(stream, data, fingerprint));
    if (fingerprintIn(previous.get(key)) !== fingerprint)
      yield { stream: stream.name, data };
  }
  for (const [key, entry] of previous)
    if (!current.has(key)) {
      const message = deleted(key, entry);
      if (message !== null) yield message;
    }
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
  readonly snapshot: Readonly<Record<string, SavedEntry>>;
};

// Each group's input fingerprint and the snapshot of the records it produced.
export type GroupedSnapshotState = {
  readonly groups: Readonly<Record<string, SavedGroup>>;
};

// diffSnapshot for a scan whose records come from inputs the source can
// fingerprint cheaply. A group whose fingerprint matches the last committed
// scan keeps its records without reading them; every other group is read and
// diffed record by record. Deletions still come from the complete scan: a key
// no group produced, carried or read, is deleted, unless the scan does not
// cover it or the stream emits no deletions, as in diffSnapshot.
export async function* diffGroupedSnapshot<
  Data extends Record<string, unknown>,
>(
  stream: Stream,
  groups: AsyncIterable<SnapshotGroup<Data>> | Iterable<SnapshotGroup<Data>>,
  state: unknown,
  options: SnapshotDiffOptions = {},
): AsyncGenerator<
  | { readonly stream: string; readonly data: Data }
  | DeleteMessage
  | StateMessage
> {
  assertSnapshotStream(stream);
  const deleted = deletion(stream, options);
  const deduplication = new Deduplication(stream, stream.primaryKey);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the checkpoint holds what diffGroupedSnapshot wrote; own state is not re-validated
  const saved = state as GroupedSnapshotState | null;
  const previous = new Map(Object.entries(saved?.groups ?? {}));
  // A record can move between groups; its previous fingerprint is then found
  // through every previous group, indexed only when a lookup misses.
  let everyPrevious: Map<string, SavedEntry> | null = null;
  const previousFingerprint = (group: SavedGroup | undefined, key: string) => {
    const same = group?.snapshot[key];
    if (same !== undefined) return fingerprintIn(same);
    everyPrevious ??= new Map(
      [...previous.values()].flatMap(({ snapshot }) =>
        Object.entries(snapshot),
      ),
    );
    return fingerprintIn(everyPrevious.get(key));
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
    const snapshot = new Map<string, SavedEntry>();
    for await (const data of group.records()) {
      const key = deduplication.key(data);
      claim(key);
      const fingerprint = fingerprintOf(stream, data);
      snapshot.set(key, entryOf(stream, data, fingerprint));
      if (previousFingerprint(before, key) !== fingerprint)
        yield { stream: stream.name, data };
    }
    current.set(group.key, {
      fingerprint: group.fingerprint,
      snapshot: sortedObject(snapshot),
    });
  }
  for (const { snapshot } of previous.values())
    for (const [key, entry] of Object.entries(snapshot))
      if (!seen.has(key)) {
        const message = deleted(key, entry);
        if (message !== null) yield message;
      }
  yield {
    type: 'STATE',
    stream: stream.name,
    state: { groups: sortedObject(current) },
  };
}

function assertSnapshotStream(stream: Stream): void {
  if (!stream.sourceDefinedCursor)
    throw new TypeError(
      `Stream ${stream.name} must declare sourceDefinedCursor to diff snapshots`,
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

// The DELETE for a vanished key, or null when its row stays: every key of a
// stream that emits no deletions, whose upstream forgets records rather than
// deleting them, and every key the scan does not cover.
function deletion(
  stream: Stream,
  { covers }: SnapshotDiffOptions,
): (key: string, entry: SavedEntry) => DeleteMessage | null {
  if (!stream.emitsDeletes) {
    if (covers !== undefined)
      throw new TypeError(
        `Stream ${stream.name} emits no deletions, so its snapshot diff takes no covers`,
      );
    return () => null;
  }
  if (stream.expiresBy !== undefined && covers === undefined)
    throw new TypeError(
      `Stream ${stream.name} expires by ${stream.expiresBy}, so its snapshot diff needs covers, such as expiredAfter(horizon)`,
    );
  return (key, entry) => {
    const recordKey = keyObject(stream, key);
    const vanished: VanishedRecord =
      typeof entry === 'string'
        ? { key: recordKey }
        : { key: recordKey, expiresBy: entry[1] };
    if (covers !== undefined && !covers(vanished)) return null;
    return { type: 'DELETE', stream: stream.name, key: recordKey };
  };
}

function entryOf(
  stream: Stream,
  record: Record<string, unknown>,
  fingerprint: string,
): SavedEntry {
  if (stream.expiresBy === undefined) return fingerprint;
  const expiresBy = record[stream.expiresBy];
  if (!isTimestamp(expiresBy))
    throw new TypeError(
      `Stream ${stream.name} records must carry ${stream.expiresBy} as a timestamp to expire`,
    );
  return [fingerprint, expiresBy];
}

function fingerprintIn(entry: SavedEntry | undefined): string | undefined {
  return typeof entry === 'string' ? entry : entry?.[0];
}

// The previous snapshot, as diffSnapshot wrote it.
function readSnapshot(state: unknown): Map<string, SavedEntry> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the checkpoint holds what diffSnapshot wrote; own state is not re-validated
  const saved = state as SnapshotState | null;
  return new Map(Object.entries(saved?.snapshot ?? {}));
}

// A snapshot key is the JSON of the primary key's values, in field order.
function keyObject(stream: Stream, key: string): Record<string, KeyValue> {
  const values: KeyValue[] = JSON.parse(key);
  return Object.fromEntries(
    stream.primaryKey.map((field, index) => {
      const value = values[index];
      if (value === undefined)
        throw new TypeError(
          `Snapshot key ${key} does not match ${stream.name}'s primary key`,
        );
      return [field, value];
    }),
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
