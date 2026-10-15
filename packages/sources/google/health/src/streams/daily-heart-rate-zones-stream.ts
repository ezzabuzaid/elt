import type { DataPoint } from '@workspace/sdk-google-health';

import { day } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class DailyHeartRateZonesStream extends PointStream {
  constructor() {
    super({
      type: 'daily-heart-rate-zones',
      name: 'dailyHeartRateZones',
      named: false,
      shared: true,
      description:
        "One record per daily-heart-rate-zones point Google Health holds for the user. User's heart rate zone thresholds based on the Karvonen algorithm for a specific day. Google keeps no id for these points, so the stream declares no key. Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        ...day.properties,
      },
    });
  }

  protected row({ dailyHeartRateZones }: DataPoint) {
    return {
      ...day.row(dailyHeartRateZones?.date),
    };
  }
}
