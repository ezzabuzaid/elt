import type { ClockSnapshot } from '@workspace/sdk-apple-clock/clock-store';

import { ClockStream, fields } from '../clock-stream.ts';

const properties = {
  id: {
    ...fields.id,
    description:
      'Identifier of this stored object. UUIDs come from MobileTimer; decimal IDs are Core Data row identifiers.',
  },
  date: {
    ...fields.instant,
    description:
      'Date value stored by MobileTimer, expressed as its UTC instant.',
  },
  typeCode: {
    ...fields.integer,
    description:
      'Apple type code as stored; no undocumented labels are inferred.',
  },
  calendarReleaseId: {
    ...fields.text,
    description: 'Identifier of the parent calendarReleases row.',
  },
} as const;

export class MakeupDaysStream extends ClockStream<typeof properties> {
  readonly name = 'makeupDays';
  readonly store = 'database';
  readonly description =
    'Workday adjustments in MobileTimer calendar releases; type codes kept as stored.';
  readonly properties = properties;
  readonly primaryKey = ['id'];
  protected rows(snapshot: ClockSnapshot) {
    return snapshot.database.makeupDays();
  }
}
