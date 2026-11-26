import { type LaneState, freshLane } from './list-walk.ts';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function foreign(stream: string): TypeError {
  return new TypeError(
    `Instagram's ${stream} stream has state it did not write`,
  );
}

export function readLane(stream: string, value: unknown): LaneState {
  if (value === undefined) return freshLane;
  if (
    !isPlainObject(value) ||
    !(value.after === null || typeof value.after === 'string') ||
    !(value.head === null || typeof value.head === 'string') ||
    typeof value.ended !== 'boolean'
  )
    throw foreign(stream);
  return { after: value.after, head: value.head, ended: value.ended };
}

// The state a scanned stream saves: where each list's scan stands, and the
// snapshot of what the scan listed so far.
export function readScan(
  stream: string,
  state: unknown,
): {
  lanes: Record<string, unknown>;
  diff: unknown;
  extra: Record<string, unknown>;
} {
  if (state === null) return { lanes: {}, diff: null, extra: {} };
  if (!isPlainObject(state) || !('diff' in state)) throw foreign(stream);
  const { diff, ...rest } = state;
  return { ...readLanes(stream, rest), diff };
}

// The state of a scanned stream whose snapshot is in its entries: where each
// list's scan stands.
export function readLanes(
  stream: string,
  state: unknown,
): { lanes: Record<string, unknown>; extra: Record<string, unknown> } {
  if (state === null) return { lanes: {}, extra: {} };
  if (!isPlainObject(state) || !isPlainObject(state.lanes))
    throw foreign(stream);
  const { lanes, ...extra } = state;
  return { lanes, extra };
}
