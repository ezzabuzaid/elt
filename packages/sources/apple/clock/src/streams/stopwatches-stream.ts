import type { ClockSnapshot } from '@workspace/sdk-apple-clock/clock-store';

import { ClockStream, fields } from '../clock-stream.ts';

const properties = {
  id: {
    ...fields.id,
    description:
      'Identifier of this stored object. UUIDs come from MobileTimer; decimal IDs are Core Data row identifiers.',
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
  readonly primaryKey = ['id'];
  protected rows(snapshot: ClockSnapshot) {
    return snapshot.stopwatches.map(({ laps: _laps, ...watch }) => watch);
  }
}
