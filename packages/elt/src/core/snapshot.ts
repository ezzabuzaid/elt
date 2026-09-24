import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Deduplication } from './deduplication.ts';
import type {
  DeleteMessage,
  KeyValue,
  RecordMessage,
  StateMessage,
} from './source.ts';
import type { Stream } from './stream.ts';

// Each key (the JSON of its primaryKey values) mapped to a fingerprint of the
// record it identified in the last committed scan.
export type SnapshotState = {
  readonly snapshot: Readonly<Record<string, string>>;
};

const fingerprintPattern = /^[A-Za-z0-9_-]{43}$/;

// Incremental reads for a source without a change feed: compare one complete
// scan with the previous snapshot, emit new or changed records, a DELETE for
// every key that vanished, then the new snapshot as the only STATE.
// An empty scan deletes everything, so a failed read must throw, never yield nothing.
export async function* diffSnapshot(
  stream: Stream,
  records:
    | AsyncIterable<Record<string, unknown>>
    | Iterable<Record<string, unknown>>,
  state: unknown,
): AsyncGenerator<RecordMessage | DeleteMessage | StateMessage> {
  if (!stream.sourceDefinedCursor || !stream.emitsDeletes)
    throw new TypeError(
      `Stream ${stream.name} must declare sourceDefinedCursor and emitsDeletes to diff snapshots`,
    );
  const deduplication = new Deduplication(stream, stream.primaryKey);
  const previous = readSnapshot(stream, deduplication, state);
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

function readSnapshot(
  stream: Stream,
  deduplication: Deduplication,
  state: unknown,
): Map<string, string> {
  if (state === null) return new Map();
  const invalid = () =>
    new TypeError(`Invalid snapshot checkpoint for stream ${stream.name}`);
  if (
    !isPlainObject(state) ||
    Object.keys(state).length !== 1 ||
    !isPlainObject(state.snapshot)
  )
    throw invalid();
  const previous = new Map<string, string>();
  for (const [key, fingerprint] of Object.entries(state.snapshot)) {
    if (
      typeof fingerprint !== 'string' ||
      !fingerprintPattern.test(fingerprint)
    )
      throw invalid();
    let record: Record<string, KeyValue>;
    try {
      record = keyObject(stream, key);
      if (deduplication.key(record) !== key) throw invalid();
    } catch {
      throw invalid();
    }
    previous.set(key, fingerprint);
  }
  return previous;
}

function keyObject(stream: Stream, key: string): Record<string, KeyValue> {
  const values: unknown = JSON.parse(key);
  if (!Array.isArray(values) || values.length !== stream.primaryKey.length)
    throw new TypeError(`Snapshot key ${key} does not match ${stream.name}`);
  return Object.fromEntries(
    stream.primaryKey.map((field, index) => [field, values[index]]),
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
