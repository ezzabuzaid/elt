import type { ClockSnapshot } from '@eltjs/sdk-apple-clock/clock-store';

import { ClockStream, fields } from '../clock-stream.ts';

const properties = {
  position: {
    ...fields.position,
    description: 'Zero-based position in the saved stopwatch list.',
  },
  uuid: {
    ...fields.id,
    description:
      'MobileTimer identifier of the stopwatch (MTStopwatchIdentifier). The list does not keep it unique.',
  },
  title: {
    ...fields.text,
    description: 'Label saved in Clock; null when none is stored.',
  },
  stateCode: {
    ...fields.integer,
    description: 'Apple stopwatch state code, as stored.',
  },
  currentInterval: {
    ...fields.number,
    description:
      'Saved current-lap interval in seconds, without adding elapsed wall time.',
  },
  offset: {
    ...fields.number,
    description: 'Saved stopwatch offset in seconds.',
  },
  previousLapsTotal: {
    ...fields.number,
    description: 'Total seconds in the completed laps, as stored.',
  },
  startedAt: {
    ...fields.instant,
    description:
      'Saved current stopwatch start anchor in UTC, to microseconds.',
  },
} as const;

export class StopwatchesStream extends ClockStream<typeof properties> {
  readonly name = 'stopwatches';
  readonly store = 'stopwatches';
  readonly description =
    'Current stopwatch state and saved timing anchors, not a historical session log.';
  readonly properties = properties;
  readonly primaryKey = ['position'];
  protected rows(snapshot: ClockSnapshot) {
    return snapshot.stopwatches.map(({ laps: _laps, ...watch }) => watch);
  }
}
