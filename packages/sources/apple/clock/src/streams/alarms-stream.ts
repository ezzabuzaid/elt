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
  enabled: { ...fields.boolean, description: 'Whether the alarm is enabled.' },
  hour: {
    ...fields.integer,
    description: 'Local alarm hour, without a timezone conversion.',
  },
  minute: { ...fields.integer, description: 'Local alarm minute.' },
  day: {
    ...fields.integer,
    description:
      'Stored calendar day component; zero for an ordinary time-only alarm.',
  },
  month: {
    ...fields.integer,
    description:
      'Stored calendar month component; zero for an ordinary time-only alarm.',
  },
  year: {
    ...fields.integer,
    description: 'Calendar year stored by MobileTimer.',
  },
  repeatSchedule: {
    ...fields.integer,
    description:
      'Apple repeat-schedule bitmask, preserved as stored; Monday uses bit 0 in the inspected Clock version.',
  },
  allowsSnooze: {
    ...fields.boolean,
    description: 'Whether snoozing is allowed.',
  },
  snoozeMinutes: {
    ...fields.integer,
    description: 'Configured snooze duration in minutes.',
  },
  sleepAlarm: {
    ...fields.boolean,
    description: 'Whether this is a sleep alarm.',
  },
  sleepSchedule: {
    ...fields.boolean,
    description: 'Stored sleep-schedule flag.',
  },
  silentModeOptions: {
    ...fields.integer,
    description: 'Apple silent-mode option bits, as stored.',
  },
  coordinationPolicy: {
    ...fields.integer,
    description: 'Apple alarm coordination policy code, as stored.',
  },
  dismissedAction: {
    ...fields.integer,
    description: 'Apple code describing the last dismissal action.',
  },
  dismissedAt: {
    ...fields.instant,
    description: 'Last stored dismissal instant in UTC, to microseconds.',
  },
  firedAt: {
    ...fields.instant,
    description: 'Last stored firing instant in UTC, to microseconds.',
  },
  keepOffUntil: {
    ...fields.instant,
    description: 'Instant until which the alarm is kept off, in UTC.',
  },
  modifiedAt: {
    ...fields.instant,
    description:
      'Stored modification instant in UTC, to microseconds; no import time is substituted.',
  },
  snoozeFireAt: {
    ...fields.instant,
    description: 'Stored snooze deadline in UTC.',
  },
  soundId: {
    ...fields.text,
    description: 'Identifier of the associated sounds row, or null.',
  },
  siriContext: {
    ...fields.bytes,
    description: 'Opaque Siri context bytes as base64, or null.',
  },
} as const;

export class AlarmsStream extends ClockStream<typeof properties> {
  readonly name = 'alarms';
  readonly store = 'database';
  readonly description =
    'Saved Clock alarms, including disabled and sleep alarms; local time components and repeat bitmask are stored without applying a timezone.';
  readonly properties = properties;
  readonly primaryKey = ['id'];
  protected rows(snapshot: ClockSnapshot) {
    return snapshot.database.alarms();
  }
}
