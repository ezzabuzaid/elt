import type { Gauge } from '@zukhruf/async';

import type { Stream } from './stream.ts';

// A change signal names a gauge, so elt exports the gauge and what its read
// takes: a source that depends on elt alone builds its signals with the one
// Gauge class that the pipeline reads.
export { type Check, Gauge } from '@zukhruf/async';

// What tells a watch that streams changed: a gauge that the watch reads at
// each check, the streams that it tells about, and how often to read it. The
// gauge opens what it reads in its first read, so a store that cannot be read
// fails the streams of the gauge, not the watch (ADR 0020).
export type ChangeSignal = {
  readonly gauge: Gauge;
  readonly streams: readonly Stream[];
  // Milliseconds from one check to the next.
  readonly interval: number;
  // Milliseconds that one read of the gauge can take; a longer read fails
  // the gauge for that check.
  readonly timeout: number;
};
