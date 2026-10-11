import type { ClockSnapshot } from '@workspace/sdk-apple-clock/clock-store';

import { ClockStream, fields } from '../clock-stream.ts';

const properties = {
  stopwatchId: {
    ...fields.id,
    description: 'Identifier of the parent stopwatches row.',
  },
  position: {
    ...fields.position,
    description:
      'Zero-based position in the stored list; preserves order and repeated entries.',
  },
  interval: {
    ...fields.number,
    description: 'Completed lap interval in seconds.',
  },
} as const;

export class StopwatchLapsStream extends ClockStream<typeof properties> {
  readonly name = 'stopwatchLaps';
  readonly store = 'stopwatches';
  readonly description =
    'Completed laps of the current stopwatch, in stored order; reset removes them.';
  readonly properties = properties;
  readonly primaryKey = ['stopwatchId', 'position'];
  protected rows(snapshot: ClockSnapshot) {
    return snapshot.stopwatches.flatMap((watch) =>
      watch.laps.map((interval, position) => ({
        stopwatchId: watch.id,
        position,
        interval,
      })),
    );
  }
}
