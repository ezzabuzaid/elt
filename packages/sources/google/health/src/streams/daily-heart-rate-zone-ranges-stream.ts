import type { DataPoint } from '@workspace/sdk-google-health';

import { ChildStream } from '../child-stream.ts';
import { calendarDate, fields } from '../health-fields.ts';
import { pointOrigin } from '../point-stream.ts';

export class DailyHeartRateZoneRangesStream extends ChildStream {
  constructor() {
    super({
      parent: 'daily-heart-rate-zones',
      name: 'dailyHeartRateZoneRanges',
      description:
        "One record per entry in the heartRateZones list of each daily-heart-rate-zones point. The heart rate zone. Its parent has no id, so each entry repeats the parent's origin and time, and the stream declares no key. Reloaded whole on every run with its parent.",
      properties: {
        ...pointOrigin.properties,
        date: {
          ...fields.date,
          description:
            'The day of the daily-heart-rate-zones point this entry belongs to.',
        },
        position: {
          type: 'integer',
          minimum: 0,
          description: "The entry's place in the list, from 0.",
        },
        heartRateZoneType: {
          ...fields.text,
          description:
            'The heart rate zone type. One of LIGHT, MODERATE, VIGOROUS, PEAK.',
        },
        maxBeatsPerMinute: {
          ...fields.int64,
          description: 'Maximum heart rate for this zone in beats per minute.',
        },
        minBeatsPerMinute: {
          ...fields.int64,
          description: 'Minimum heart rate for this zone in beats per minute.',
        },
      },
    });
  }

  protected rows(point: DataPoint) {
    return (point.dailyHeartRateZones?.heartRateZones ?? []).map(
      (entry, position) => ({
        ...pointOrigin.row(point),
        date: calendarDate(point.dailyHeartRateZones?.date),
        position,
        heartRateZoneType: entry?.heartRateZoneType ?? null,
        maxBeatsPerMinute: entry?.maxBeatsPerMinute ?? null,
        minBeatsPerMinute: entry?.minBeatsPerMinute ?? null,
      }),
    );
  }
}
