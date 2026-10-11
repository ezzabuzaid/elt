import type { ClockSnapshot } from '@workspace/sdk-apple-clock/clock-store';

import { ClockStream, fields } from '../clock-stream.ts';

const properties = {
  id: {
    ...fields.id,
    description:
      'Identifier of this stored object. UUIDs come from MobileTimer; decimal IDs are Core Data row identifiers.',
  },
  region: {
    ...fields.text,
    description: 'Region code associated with the calendar release.',
  },
  year: { ...fields.text, description: 'Calendar year stored by MobileTimer.' },
  releasedAt: {
    ...fields.instant,
    description: 'Calendar release instant in UTC.',
  },
  checkedAt: {
    ...fields.instant,
    description: 'Last calendar-release check instant in UTC.',
  },
} as const;

export class CalendarReleasesStream extends ClockStream<typeof properties> {
  readonly name = 'calendarReleases';
  readonly store = 'database';
  readonly description =
    'Regional calendar releases MobileTimer stores for adjusted workday alarm schedules.';
  readonly properties = properties;
  readonly primaryKey = ['id'];
  protected rows(snapshot: ClockSnapshot) {
    return snapshot.database.calendarReleases();
  }
}
