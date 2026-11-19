import type { FailureType } from '../core/source.ts';
import type { SyncStatus } from './sync-history.ts';

// running: begun and not yet ended, or left so by a process that stopped
// during it.
export type PassState = SyncStatus | 'running';

// currentAsOf is when everything the connector loaded last matched its
// upstream, as sync_status.current_as_of says.
type Started = {
  readonly startedAt: string;
  readonly lastSucceededAt: string | null;
  readonly currentAsOf: string | null;
};

// Only a pass that ended has completedAt, only one that did not load
// completely has an error, and only one whose copies failed says whose the
// failure is to fix.
export type PassStatus =
  | (Started & {
      readonly state: 'running';
      readonly completedAt: null;
      readonly error: null;
      readonly failureType: null;
    })
  | (Started & {
      readonly state: 'succeeded';
      readonly completedAt: string;
      readonly error: null;
      readonly failureType: null;
    })
  | (Started & {
      readonly state: 'cancelled';
      readonly completedAt: string;
      readonly error: string;
      readonly failureType: null;
    })
  | (Started & {
      readonly state: 'partial' | 'failed';
      readonly completedAt: string;
      readonly error: string;
      readonly failureType: FailureType;
    });

// Only a stream whose copies failed in its latest attempt has an error.
export type StreamPassStatus = {
  readonly stream: string;
  readonly lastSucceededAt: string | null;
  readonly currentAsOf: string | null;
} & (
  | {
      readonly state: 'running' | 'succeeded' | 'cancelled';
      readonly error: null;
    }
  | { readonly state: 'partial' | 'failed'; readonly error: string }
);

type Ended = Exclude<PassStatus, { readonly state: 'running' }>;

// The latest passes of the connections of one destination as one pass, which
// is only as good as its worst connection: it runs while any of them runs,
// began when the first began, ended when the last ended, and is current only
// as of the least current. A failure of one connection makes the pass
// partial, not succeeded, and its error keeps the error of each connection
// that did not succeed, as Go's errors.Join does, one on each line.
export function combinedPass(
  passes: readonly [PassStatus, ...PassStatus[]],
): PassStatus {
  const started = {
    startedAt: earliest(passes.map(({ startedAt }) => startedAt)),
    lastSucceededAt: earliestOfAll(
      passes.map(({ lastSucceededAt }) => lastSucceededAt),
    ),
    currentAsOf: earliestOfAll(passes.map(({ currentAsOf }) => currentAsOf)),
  };
  const ended = passes.filter(
    (pass): pass is Ended => pass.state !== 'running',
  );
  if (ended.length < passes.length)
    return {
      ...started,
      state: 'running',
      completedAt: null,
      error: null,
      failureType: null,
    };
  const completedAt = latest(ended.map(({ completedAt }) => completedAt));
  const error = ended
    .flatMap((pass) => (pass.error === null ? [] : [pass.error]))
    .join('\n');
  if (ended.some(({ state }) => state === 'cancelled'))
    return {
      ...started,
      state: 'cancelled',
      completedAt,
      error,
      failureType: null,
    };
  if (ended.every(({ state }) => state === 'succeeded'))
    return {
      ...started,
      state: 'succeeded',
      completedAt,
      error: null,
      failureType: null,
    };
  return {
    ...started,
    state: ended.every(({ state }) => state === 'failed')
      ? 'failed'
      : 'partial',
    completedAt,
    error,
    failureType: ended.some(({ failureType }) => failureType === 'config')
      ? 'config'
      : 'system',
  };
}

function earliest(instants: readonly string[]): string {
  return instants.reduce((first, next) =>
    Date.parse(next) < Date.parse(first) ? next : first,
  );
}

function latest(instants: readonly string[]): string {
  return instants.reduce((last, next) =>
    Date.parse(next) > Date.parse(last) ? next : last,
  );
}

// The earliest instant, or null when any of them is null.
function earliestOfAll(instants: readonly (string | null)[]): string | null {
  const known = instants.filter((instant) => instant !== null);
  return known.length < instants.length ? null : earliest(known);
}
