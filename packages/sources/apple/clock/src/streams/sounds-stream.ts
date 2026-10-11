import type { ClockSnapshot } from '@workspace/sdk-apple-clock/clock-store';

import { ClockStream, fields } from '../clock-stream.ts';

const properties = {
  id: {
    ...fields.id,
    description:
      'Identifier of this stored object. UUIDs come from MobileTimer; decimal IDs are Core Data row identifiers.',
  },
  typeCode: {
    ...fields.integer,
    description:
      'Apple type code as stored; no undocumented labels are inferred.',
  },
  volume: {
    ...fields.number,
    description: 'Stored sound volume, preserving sentinel values such as -1.',
  },
  toneId: { ...fields.text, description: 'System tone identifier.' },
  vibrationId: {
    ...fields.text,
    description: 'System vibration identifier; may be an empty string.',
  },
  mediaItemId: {
    ...fields.int64,
    description:
      'Media-library sound identifier as an exact signed 64-bit integer string.',
  },
} as const;

export class SoundsStream extends ClockStream<typeof properties> {
  readonly name = 'sounds';
  readonly store = 'database';
  readonly description =
    'Sound configurations referenced by alarms, timers and retained timer durations.';
  readonly properties = properties;
  readonly primaryKey = ['id'];
  protected rows(snapshot: ClockSnapshot) {
    return snapshot.database.sounds();
  }
}
