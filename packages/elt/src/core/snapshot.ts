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
  if (!stream.sourceDefinedCursor || !stream.emitsDeletes)
    throw new TypeError(
      `Stream ${stream.name} must declare sourceDefinedCursor and emitsDeletes to diff snapshots`,
    );
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
  const snapshot = Object.fromEntries(
    [...current].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  yield { type: 'STATE', stream: stream.name, state: { snapshot } };
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
