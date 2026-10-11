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
    description: 'Apple timer state code: 1 stopped, 2 paused, 3 running.',
  },
  duration: {
    ...fields.number,
    description: 'Configured timer duration in seconds.',
  },
  soundId: {
    ...fields.text,
    description: 'Identifier of the associated sounds row, or null.',
  },
  dismissedAt: {
    ...fields.instant,
    description: 'Last stored dismissal instant in UTC, to microseconds.',
  },
  firedAt: {
    ...fields.instant,
    description: 'Last stored firing instant in UTC, to microseconds.',
  },
  modifiedAt: {
    ...fields.instant,
    description:
      'Stored modification instant in UTC, to microseconds; no import time is substituted.',
  },
  url: { ...fields.text, description: 'Clock URL identifying the timer.' },
  siriContext: {
    ...fields.bytes,
    description: 'Opaque Siri context bytes as base64, or null.',
  },
  timerContext: {
    ...fields.bytes,
    description: 'Opaque timer context bytes as base64, or null.',
  },
  fireAt: {
    ...fields.instant,
    description:
      'Running timer deadline in UTC, to microseconds; null for interval-based timers.',
  },
  remainingSeconds: {
    ...fields.number,
    description:
      'Stored remaining seconds for a stopped or paused timer; null for a running deadline.',
  },
  fireTime: {
    ...fields.text,
    description:
      'Original keyed fire-time archive as JSON, retaining class and reference-date seconds.',
  },
} as const;

export class TimersStream extends ClockStream<typeof properties> {
  readonly name = 'timers';
  readonly store = 'database';
  readonly description =
    'Current stored timers, including the stopped default timer; running deadlines and paused remaining durations are stored without a moving countdown.';
  readonly properties = properties;
  readonly primaryKey = ['id'];
  protected rows(snapshot: ClockSnapshot) {
    return snapshot.database.timers();
  }
}
