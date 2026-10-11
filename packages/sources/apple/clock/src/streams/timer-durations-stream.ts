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
  duration: {
    ...fields.number,
    description: 'Configured timer duration in seconds.',
  },
  favorite: {
    ...fields.boolean,
    description: 'Whether this retained timer duration is a favorite.',
  },
  latest: {
    ...fields.boolean,
    description: 'Whether this is the latest timer duration.',
  },
  validRecent: {
    ...fields.boolean,
    description:
      'Whether MobileTimer considers the duration a valid recent timer.',
  },
  modifiedAt: {
    ...fields.instant,
    description:
      'Stored modification instant in UTC, to microseconds; no import time is substituted.',
  },
  soundId: {
    ...fields.text,
    description: 'Identifier of the associated sounds row, or null.',
  },
} as const;

export class TimerDurationsStream extends ClockStream<typeof properties> {
  readonly name = 'timerDurations';
  readonly store = 'database';
  readonly description =
    'Clock recent and favorite timer durations retained by MobileTimer, not a history of every timer run.';
  readonly properties = properties;
  readonly primaryKey = ['id'];
  protected rows(snapshot: ClockSnapshot) {
    return snapshot.database.timerDurations();
  }
}
