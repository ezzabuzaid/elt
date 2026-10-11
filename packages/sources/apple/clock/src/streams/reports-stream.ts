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
  concerns: {
    ...fields.integer,
    description: 'MobileTimer report concern code, as stored.',
  },
} as const;

export class ReportsStream extends ClockStream<typeof properties> {
  readonly name = 'reports';
  readonly store = 'database';
  readonly description = 'MobileTimer reports with their stored concern codes.';
  readonly properties = properties;
  readonly primaryKey = ['id'];
  protected rows(snapshot: ClockSnapshot) {
    return snapshot.database.reports();
  }
}
